# Codebase-Notes — Zoo Remote (Session 0)

**Verifiziert gegen Klon-Stand:** `134923e1577efb3c284070fe6956c5b89a3884f1`
(Shallow-Clone von https://github.com/Zoo-Code-Org/Zoo-Code, 2026-09-08. **Nicht pullen** während der Umsetzung.)

Alle Pfade relativ zum Repo-Root. Zeilennummern beziehen sich auf den oben genannten Commit.

---

## 1. TASK-STATUS: „Wartet die aktive Task auf Eingabe?"

### 1.1 `ClineMessage` — Typ & Ask-Werte

**Datei:** `packages/types/src/message.ts`

- `clineAsks` (Zeilen 27–39): alle möglichen Ask-Typen:
    ```ts
    export const clineAsks = [
    	"followup",
    	"command",
    	"command_output",
    	"completion_result",
    	"tool",
    	"api_req_failed",
    	"resume_task",
    	"resume_completed_task",
    	"mistake_limit_reached",
    	"use_mcp_server",
    	"auto_approval_max_req_reached",
    ] as const
    export type ClineAsk = z.infer<typeof clineAskSchema> // Zeile 43
    ```
- Kategorien (wichtig für Approve/Deny vs. Freitext):
    - `idleAsks` (Zeilen 50–56): `completion_result, api_req_failed, resume_completed_task, mistake_limit_reached, auto_approval_max_req_reached` → Helper `isIdleAsk()` (Zeile 60)
    - `resumableAsks` (Zeile 70): nur `resume_task` → `isResumableAsk()` (Zeile 74)
    - **`interactiveAsks`** (Zeile 84): `followup, command, tool, use_mcp_server` → `isInteractiveAsk()` (Zeile 88) — **diese sind „wartet auf Eingabe" im Sinne von Remote-Notification**
    - `nonBlockingAsks` (Zeile 99): nur `command_output` → `isNonBlockingAsk()` (Zeile 103)

- `clineMessageSchema` / `ClineMessage` (Zeilen 250–279), relevante Felder:

    ```ts
    ts: number
    type: "ask" | "say"
    ask?: ClineAsk          // nur bei type === "ask"
    say?: ClineSay           // nur bei type === "say"
    text?: string            // Frage-/Beschreibungstext (für summary/question nutzbar)
    partial?: boolean
    isAnswered?: boolean     // Zeile 275 — wird beim Beantworten auf true gesetzt
    ```

- `ClineAskResponse` (`packages/types/src/vscode-extension-host.ts:450`):
    ```ts
    export type ClineAskResponse = "yesButtonClicked" | "noButtonClicked" | "messageResponse" | "objectResponse"
    ```
    → Passt exakt zum geplanten `POST /api/ask/respond`-Body.

### 1.2 Wie „wartet auf Eingabe" erkannt wird (Kernantwort)

**Datei:** `src/core/task/Task.ts`

Nicht primär über `task.askResponse === undefined` (das ist ein privates, transientes Feld während des internen `pWaitFor`, Zeile 348), sondern über die **Ask-State-Felder + Status-Getter**:

```ts
// Task.ts:315–318
idleAsk?: ClineMessage        // letzte unbeantwortete idle-Ask (completion_result, api_req_failed, …)
resumableAsk?: ClineMessage   // resume_task
interactiveAsk?: ClineMessage // followup / command / tool / use_mcp_server  ← „Eingabe erforderlich"

// Task.ts:5167–5185
public get taskStatus(): TaskStatus {
  if (this.interactiveAsk) return TaskStatus.Interactive
  if (this.resumableAsk)   return TaskStatus.Resumable
  if (this.idleAsk)        return TaskStatus.Idle
  return TaskStatus.Running
}
public get taskAsk(): ClineMessage | undefined {
  return this.idleAsk || this.resumableAsk || this.interactiveAsk
}
```

`TaskStatus`-Enum: `packages/types/src/task.ts:99–105` → `Running, Interactive, Resumable, Idle, None`.

**Mechanik:** In `Task.ask()` (ab Zeile 1404) wird nach dem Blocking-Wait (`pWaitFor`, ab Zeile 1624) bei `isStatusMutable` ein 2-s-Timer gesetzt (Zeilen 1578–1621), der das passende Feld setzt und **Events emittiert**:

- `interactiveAsk = message; emit(RooCodeEventName.TaskInteractive, taskId)` — Zeile 1587–1588
- `resumableAsk` → `TaskResumable` (Zeile 1602–1603)
- `idleAsk` → `TaskIdle` (Zeile 1613–1614)

Beim Beantworten (`handleWebviewAskResponse`, Zeile 1689 ff.) werden die Felder auf `undefined` gesetzt und `TaskActive` emittiert (Zeilen 1678–1682). Zusätzlich wird die letzte offene followup/tool-Ask in `clineMessages` mit `isAnswered = true` markiert (Zeilen 1707–1735) — Fallback-Erkennung über `clineMessages.at(-1)` + `!isAnswered` ist also auch möglich, aber der **Status-Getter ist der saubere Weg**.

### 1.3 Ask-Typ → erwartete Antwort (für `canApprove`/`expectsText` in RemoteStatus)

| ask                                                                                  | UI-Antwort                   | Remote-Mapping                                              |
| ------------------------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------- |
| `tool`, `command`, `use_mcp_server`                                                  | ja/nein-Buttons              | `yesButtonClicked` / `noButtonClicked` → `canApprove: true` |
| `auto_approval_max_req_reached`                                                      | ja/nein (manuell genehmigen) | `canApprove: true`                                          |
| `followup`                                                                           | Freitext                     | `messageResponse` + text → `expectsText: true`              |
| `api_req_failed`                                                                     | Retry/Abbrechen              | `yesButtonClicked` (retry) / `noButtonClicked`              |
| `completion_result`, `resume_task`, `resume_completed_task`, `mistake_limit_reached` | Buttons bzw. Follow-up       | ja/nein; bei completion zusätzlich Freitext möglich         |

> ⚠️ **Nicht verifiziert:** ob die Webview-UI für `completion_result` exakt „Neue Task"-Buttons oder auch Freitext anbietet — Remote kann beides anbieten (`canApprove: true, expectsText: true`).
> ⚠️ **Caveat:** `command_output` ist non-blocking und setzt keinen der drei Ask-Zustände → taucht nicht in `taskStatus` auf (bewusst, es ist Flow-Control).

---

## 2. AKTIONEN (exakte Codepfade wiederverwenden)

### 2.1 Approve/Deny/Antwort

**Datei:** `src/core/webview/webviewMessageHandler.ts`, Fall `askResponse` (Zeilen 719–726):

```ts
case "askResponse": {
  const resolved = await resolveIncomingImages({ text: message.text, images: message.images })
  provider.getCurrentTask()?.handleWebviewAskResponse(message.askResponse!, resolved.text, resolved.images)
}
```

**Aufzurufende Methode am Task:** `src/core/task/Task.ts`

```ts
// Zeile 1689
handleWebviewAskResponse(askResponse: ClineAskResponse, text?: string, images?: string[]) { ... }

// Öffentliche Convenience-Wrapper (Zeilen 1751–1757), Teil des TaskLike-Interfaces:
public approveAsk({ text, images }: { text?: string; images?: string[] } = {}) // → "yesButtonClicked"
public denyAsk({ text, images }: { text?: string; images?: string[] } = {})     // → "noButtonClicked"
```

`approveAsk`/`denyAsk` sind in `TaskLike` deklariert (`packages/types/src/task.ts:128–129`) — ideal für den Remote-Aufruf. Für Freitext direkt `handleWebviewAskResponse("messageResponse", text)`.

### 2.2 Moduswechsel

**Datei:** `webviewMessageHandler.ts` (Zeilen 1927–1929):

```ts
case "mode":
  await provider.handleModeSwitch(message.text as Mode)
  break
```

**Methode am Provider:** `src/core/webview/ClineProvider.ts:1716`:

```ts
public async handleModeSwitch(newMode: Mode, targetTask: Task | null | undefined = this.getCurrentTask()): Promise<void>
```

- Emittiert `RooCodeEventName.ModeChanged` (Zeile 1759) und postet State (Zeilen 1764–1821).
- Achtung: intern via `enqueueProviderProfileMutation(...)` serialized — Aufruf ist idempotent-safe, einfach aufrufen.

### 2.3 Modell/Provider-Profil lesen & wechseln

**Datei:** `src/core/webview/ClineProvider.ts`

```ts
// Zeile 1992 — Profil aktivieren (das ist der „Modellwechsel"-Aufruf):
async activateProviderProfile(
  args: { name: string } | { id: string },
  options?: { persistModeConfig?: boolean; persistTaskHistory?: boolean; skipCurrentTaskRebuild?: boolean },
)
```

- Intern: `providerSettingsManager.activateProfile(args)` → setzt `listApiConfigMeta`, `currentApiConfigName` + Provider-Settings, baut Task-API neu auf, emittiert `RooCodeEventName.ProviderProfileChanged` (Zeile 2051).

**Profil-Liste:** `src/core/config/ProviderSettingsManager.ts:360`:

```ts
public async listConfig(): Promise<ProviderSettingsEntry[]>   // provider.providerSettingsManager.listConfig()
```

`ProviderSettingsEntry` (`packages/types/src/provider-settings.ts:172–179`): `{ id: string; name?: string; apiProvider?; modelId?: string }`.

**Aktuelle Modell-Info für Status:** über `getStateToPostToWebview()` → `ExtensionState.apiConfiguration: ProviderSettings` (enthält u. a. `apiProvider`, `modelId`) + `currentApiConfigName`/`listApiConfigMeta` im State (`packages/types/src/vscode-extension-host.ts:267–268, 340`).

> ⚠️ **Nicht verifiziert (Details):** `upsertProviderProfile(name, apiConfiguration)` existiert ebenfalls (ClineProvider.ts:1878) — für Remote-Wechsel reicht aber `activateProviderProfile` mit bestehendem Profil. Die `TaskProviderLike`-Methoden `getProviderProfiles()/setProviderProfile()` (task.ts:34–36) sind im Interface, Implementierungsdetails nicht einzeln gecheckt.

---

## 3. STATE / EVENTS

### 3.1 Provider-Events (`TaskProviderEvents`)

**Typ:** `packages/types/src/task.ts:55–80` (Event-Namen als Enum in `packages/types/src/events.ts:11–54`, z. B. `RooCodeEventName.TaskInteractive = "taskInteractive"`):

```ts
export type TaskProviderEvents = {
	[TaskCreated]: [task: TaskLike]
	[TaskStarted]: [taskId: string]
	[TaskCompleted]: [taskId, tokenUsage, toolUsage]
	[TaskAborted]: [taskId]
	[TaskFocused | TaskUnfocused | TaskActive | TaskInteractive | TaskResumable | TaskIdle]: [taskId]
	[TaskPaused | TaskUnpaused | TaskSpawned]: [taskId]
	[TaskDelegated]: [parentTaskId, childTaskId] // + DelegationCompleted/Resumed
	[TaskUserMessage]: [taskId]
	[TaskTokenUsageUpdated]: [taskId, tokenUsage, toolUsage]
	[ModeChanged]: [mode: string]
	[ProviderProfileChanged]: [config: { name: string; provider?: string }]
}
```

`ClineProvider extends EventEmitter<TaskProviderEvents>` (`src/core/webview/ClineProvider.ts:176–178`). Emission-Punkte im Provider: Zeilen 385–440 (Task-Lifecycle-Listener), `ModeChanged` Zeile 1759, `ProviderProfileChanged` Zeile 2051.

**→ Für die RemoteStateBridge:** auf `ClineProvider.on("taskInteractive" | "taskActive" | "taskIdle" | …)` + `modeChanged` + `providerProfileChanged` hören und jeweils einen Status-Snapshot bauen (pull via `getStateToPostToWebview()` + `getCurrentTask()`).

### 3.2 Task-Events (feinkörniger, optional)

`packages/types/src/task.ts:134–161`: `TaskEvents` inkl. `[Message]: [{ action: "created" | "updated"; message: ClineMessage }]`, `TaskAskResponded`, `TaskModeSwitched`. Task ist ebenfalls EventEmitter — falls Live-Update pro Nachricht gewünscht ist.

### 3.3 State-Bau

**Datei:** `src/core/webview/ClineProvider.ts`

```ts
// Zeile 2583
async getStateToPostToWebview({ includeTaskHistory = true }: GetStateOptions = {}): Promise<ExtensionState>
// Zeile 2420 — postet State an die Webview (für Remote nicht nötig, nur Snapshot ziehen)
async postStateToWebview(): Promise<void>
```

`ExtensionState` (`packages/types/src/vscode-extension-host.ts`, Felder ab ~Zeile 339):

- `mode: string` (Zeile 363), `customModes: ModeConfig[]` (Zeile 364)
- `apiConfiguration: ProviderSettings` (Zeile 340) — enthält aktives Modell/Provider
- `clineMessages: ClineMessage[]`, `currentTaskId?: string` (Zeilen 336–337), `version: string` (Zeile 335)

**→ RemoteStatus-Mapping:** `mode.current = state.mode`; `model.* = state.apiConfiguration.{apiProvider, modelId}` + `currentApiConfigName`; Task-Status aus `provider.getCurrentTask()?.taskStatus / .taskAsk`.

---

## 4. EXTENSION-ENTRY (Ein-/Ausschaltstelle für RemoteServer)

**Datei:** `src/extension.ts`

- `activate(context)` — Zeile 119.
- `const contextProxy = await ContextProxy.getInstance(context)` — **Zeile 173**.
- `const provider = new ClineProvider(context, outputChannel, "sidebar", contextProxy, mdmService)` — **Zeile 222** (Kommentar: „Initialize the provider _before_ the Roo Code Cloud service").
- Webview-Registrierung über `context.subscriptions.push(...)` — Zeilen 252–256.
- Ende von activate: `return new API(outputChannel, provider, socketPath, enableLogging)` — **Zeile 380** (API = IPC-Socket-Erweiterung aus `src/extension/api.ts`, nur wenn Env `ROO_CODE_IPC_SOCKET_PATH` gesetzt ist — Lektüre-Referenz für Event-Serialisierung, kein Netzwerkserver).
- `deactivate()` — Zeilen 384–415: räumt CloudService, McpServerManager, Telemetry auf.

**Empfohlene Einfügeposition:** direkt nach Zeile 256 (Provider + Webview registriert), z. B.:

```ts
const remoteServer = new RemoteServer(context, contextProxy, provider)
void remoteServer.startIfEnabled() // liest remote.enabled/port/token aus globalState
context.subscriptions.push(remoteServer) // mit dispose() → stop()
```

---

## 5. SETTINGS (Konvention für neue Keys)

**Datei:** `src/core/config/ContextProxy.ts`

- `getGlobalState(key)` / `updateGlobalState(key, value)` — Zeilen 351–370 (typsicher über `keyof GlobalState`).
- Generische `setValue/getValue` für `RooCodeSettings`-Keys — ~Zeilen 536–548: dispatcht je nach Key-Typ auf SecretStorage (`storeSecret`) oder globalState.
- `getValues(): RooCodeSettings` — Zeile 550 (komplett gemerchter State).

**Wichtig für neue Settings:** Keys sind typisiert über die Schemas in `packages/types/src/global-settings.ts`:

```ts
// Zeile 368
export const GLOBAL_STATE_KEYS = [...GLOBAL_SETTINGS_KEYS, ...PROVIDER_SETTINGS_KEYS].filter(
	(key) => !isSecretStateKey(key),
)
```

→ Neue Keys (`remoteEnabled`, `remotePort`, …) müssen in das `GlobalState`-Schema/`GLOBAL_SETTINGS_KEYS` dort eingetragen werden, sonst sind sie nicht typsicher lesbar. Konvention der Bestands-Keys: **camelCase** (z. B. `autoApprovalEnabled`, `currentApiConfigName`, `listApiConfigMeta`).

**Für den Token:** SecretStorage bevorzugen — entweder als neuer Key in `SECRET_STATE_KEYS`/`GLOBAL_SECRET_KEYS` (global-settings.ts) oder direkt `context.secrets.get/set("remoteAuthToken")` (ContextProxy kapselt das intern; direkter Zugriff auf `context.secrets` ist im Extension-Host üblich, vgl. ContextProxy.initialize Zeilen 70–88).

---

## 6. MODI (Liste inkl. Custom Modes)

**Datei:** `src/core/webview/ClineProvider.ts:3682–3689`

```ts
public async getModes(): Promise<{ slug: string; name: string }[]> {
  const customModes = await this.customModesManager.getCustomModes()
  return [...DEFAULT_MODES, ...customModes].map(({ slug, name }) => ({ slug, name }))
}
```

- `DEFAULT_MODES` kommt aus `@roo-code/types` (Import Zeile 54).
- Custom Modes: `this.customModesManager.getCustomModes()` — Manager wird in der Provider-Konstruktion erzeugt (`new CustomModesManager(this.context, …)`, Zeile 358).
- Aktuelle Mode lesen: `provider.getMode(): Promise<string>` (TaskProviderLike, task.ts:30; State-Feld `mode`).

**→ Remote:** `GET /api/modes` = `await provider.getModes()`; `POST /api/mode {slug}` = `await provider.handleModeSwitch(slug)`.

---

## 7. ABHÄNGIGKEITEN & Node-Version

- **Node:** `.nvmrc` → `22.23.1`; `package.json` engines: `"node": "22.23.1"`, `@types/node: 22.20.1`.
- **Monorepo:** pnpm + Turbo; Extension-Code liegt im Repo-Root unter `src/`, interne Pakete unter `packages/*` (`@roo-code/types`, `@roo-code/telemetry`, …).
- **`ws`:** nicht in Verwendung — kein Import in `src/` oder `packages/`, kein Eintrag in den geprüften `package.json`s (root, packages/types, packages/cloud). → Muss neu als Dependency des Root-Pakets ergänzt werden (`ws` + dev `@types/ws`).
- **`selfsigned`:** ebenfalls nicht in Verwendung. → Neu ergänzen (`selfsigned` + dev `@types/selfsigned`).
- Hinweis: `node_modules` war zum Verifizierungszeitpunkt noch nicht installiert (nur Klon) — transitive Dependencies anderer Pakete wurden daher nicht geprüft.

---

## Abweichungen vom Plan / offene Punkte

1. **Ask-Erkennung:** Im Plan (`docs/architektur.md` §4) stand „letzte ClineMessage mit `type === "ask"` + `task.askResponse === undefined`". Verifiziert: Sauberer Weg sind die Task-Felder `interactiveAsk/resumableAsk/idleAsk` bzw. Getter **`task.taskStatus`** (TaskStatus-Enum) und **`task.taskAsk`**, plus Provider-Events `taskInteractive/taskActive/…`. `askResponse` ist privat/transient, `isAnswered` auf der ClineMessage als Fallback.
2. **„Modell wechseln"** = Profil-Aktivierung: Es gibt keine einzelne „modelId setzen"-API für laufende Tasks; `activateProviderProfile({ name | id })` ist der offizielle Pfad und macht alles (State, Task-Rebuild, Event). `GET /api/models` liefert am besten `{ profiles: listConfig(), currentApiConfigName }`; das „aktive Modell" zusätzlich aus `state.apiConfiguration.modelId`.
3. **API-Klasse** (`src/extension/api.ts`) nutzt optional einen IPC-Socket (Env-gesteuert) — nicht verwechseln mit unserem Remote-Server; gut als Muster für EventEmitter-basierte Serialisierung.
4. ⚠️ Nicht verifiziert: exakte Webview-Buttons bei `completion_result`; Implementierungsdetails von `getProviderProfiles()/setProviderProfile()` am Provider (Interface-sicher, aber nicht im Body gecheckt); transitive Dependencies ohne installierte `node_modules`.
