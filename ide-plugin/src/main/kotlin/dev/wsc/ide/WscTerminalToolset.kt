package dev.wsc.ide

import com.intellij.mcpserver.McpExpectedError
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.application.EDT
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonObject
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/**
 * A real Terminal tab, which the IDE's own `execute_terminal_command` does not give: that tool runs
 * the command with its stdin, stdout and stderr on pipes (measured on WebStorm 2026.2.3 — `[ -t 1 ]`
 * is false, `TERM` is empty), so anything that draws its own screen (ngrok, top, a progress bar)
 * shows nothing and Ctrl-C never reaches the process. This opens the same kind of tab the "+" button
 * does — a shell on a pseudo-terminal — titles it, and types the command into it.
 */
class WscTerminalToolset : McpToolset {

    @McpTool(name = "open_terminal_tab")
    @McpDescription(
        """
        |Open a new tab in the IDE's Terminal tool window, running the user's shell on a real terminal
        |in the project root, title it `tabName`, and execute `command` in it.
        |Returns as soon as the command has been sent; it does not wait for the command to finish.
        """,
    )
    suspend fun open_terminal_tab(
        @McpDescription("Title of the new Terminal tab") tabName: String,
        @McpDescription("Shell command line to execute in the tab") command: String,
    ): String {
        val project = currentCoroutineContext().project
        val workingDirectory = project.basePath
            ?: throw fail("${project.name} has no base directory to open a terminal in")

        // Creating a tab touches the tool window's UI state, which the IDE does on the EDT.
        withContext(Dispatchers.EDT) {
            // Deprecated in 262, and used anyway. Its replacement, TerminalToolWindowTabsManager, is
            // @ApiStatus.Experimental and lives in the terminal plugin's optional content module
            // intellij.terminal.frontend, whose classes a plugin that only <depends> on the terminal
            // plugin is not guaranteed to see at run time. This one is in the plugin's main jar.
            //
            // requestFocus = true shows the Terminal tool window, so the tab is visible like any other;
            // deferSessionStartUntilUiShown = false starts the shell now, even if the tool window was
            // hidden, since a deferred session would wait for a UI event that may never come.
            @Suppress("DEPRECATION")
            val widget = TerminalToolWindowManager.getInstance(project)
                .createShellWidget(workingDirectory, tabName, true, false)
            // Queued until the shell is ready, then typed in and executed, as if by the user.
            widget.sendCommandToExecute(command)
        }

        return "opened terminal tab \"$tabName\""
    }

    private fun fail(text: String) = McpExpectedError(text, JsonObject(emptyMap()))
}
