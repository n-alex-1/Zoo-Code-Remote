import { expect, test } from "../../../../playwright/coverage-fixture"
import { expectContrast } from "../../../../playwright/contrast"
import { expectBoundedLayout } from "../../../../playwright/layout-contracts"
import { mountedStory } from "../../../../playwright/mounted-story"
import { applyVisualTheme, visualThemes } from "../../../../playwright/themes"

for (const theme of visualThemes) {
	test(`renders the production remote control settings in the VS Code ${theme.name} theme`, async ({ mount, page }) => {
		const component = mountedStory(await mount("remote-control-settings"))
		await applyVisualTheme(page, theme)
		const story = component.getByTestId("remote-control-story")

		// Live state arrives via the remoteInfo message dispatched by the story; wait until it is applied.
		await expect(story.getByText("Server running.")).toBeVisible()
		await expect(story.getByTestId("remote-token-copy")).toBeEnabled()
		const heading = story.getByRole("heading", { name: "Remote Control" })
		await expect(heading).toBeVisible()
		await expectContrast(heading, {
			background: heading.locator(".."),
			label: `${theme.name} remote control settings heading`,
		})
		await expect(story).toHaveScreenshot(`remote-control-settings-${theme.name}.png`)
	})
}

test("keeps the pairing action row bounded at the reflow width", async ({ mount, page }) => {
	const component = mountedStory(await mount("remote-control-settings"))
	const story = component.getByTestId("remote-control-story")
	await expect(story.getByText("Server running.")).toBeVisible()
	const startPairingButton = story.getByTestId("remote-pairing-start")

	await expectBoundedLayout(page, story, {
		actionRows: [startPairingButton.locator("..")],
		focusedControl: startPairingButton,
	})
})
