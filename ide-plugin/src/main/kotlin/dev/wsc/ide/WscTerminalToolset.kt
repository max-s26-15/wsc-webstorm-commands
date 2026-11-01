package dev.wsc.ide

import com.intellij.mcpserver.McpExpectedError
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.terminal.ui.TerminalWidget
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
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
        |With `kind`, the tab is marked as `wsc`'s for `list_running`, `stop_terminal_tab` and `restart_terminal_tab`.
        """,
    )
    suspend fun open_terminal_tab(
        @McpDescription("Title of the new Terminal tab") tabName: String,
        @McpDescription("Shell command line to execute in the tab") command: String,
        @McpDescription("Kind of preset entry the tab runs: config (a run configuration) or custom (the user's own commands)")
        kind: String? = null,
        @McpDescription("Mode the entry was launched in: run, debug or terminal (default: terminal)")
        mode: String? = null,
        @McpDescription("Inspector port, when the entry is debugged through the terminal")
        debugPort: Int? = null,
    ): String {
        val project = currentCoroutineContext().project
        val workingDirectory = project.basePath
            ?: throw fail("${project.name} has no base directory to open a terminal in")
        val mark = kind?.let { TabMark(tabName, it, mode ?: "terminal", debugPort) }
        if (mark != null && (mark.kind !in TabMarks.KINDS || mark.mode !in TabMarks.MODES)) {
            throw fail("kind must be one of ${TabMarks.KINDS} and mode one of ${TabMarks.MODES}, got $kind/$mode")
        }

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
            if (mark != null) TabMarks.put(widget, mark)
            // Queued until the shell is ready, then typed in and executed, as if by the user.
            widget.sendCommandToExecute(command)
        }

        return "opened terminal tab \"$tabName\""
    }

    @McpTool(name = "stop_terminal_tab")
    @McpDescription(
        """
        |Stop the command running in the Terminal tabs `open_terminal_tab` marked with this kind and entry name, by
        |pressing Ctrl-C in them; the tabs stay open. Fails if the command is still running 5 seconds later.
        |An entry with no command running is not an error: there is nothing left to stop.
        """,
    )
    suspend fun stop_terminal_tab(
        @McpDescription("Kind of preset entry: config or custom") kind: String,
        @McpDescription("Name of the preset entry the tab was opened for") entryName: String,
    ): String {
        val stopped = interrupt(currentCoroutineContext().project, kind, entryName)
        return if (stopped.isEmpty()) "\"$entryName\" is not running" else "stopped \"$entryName\""
    }

    @McpTool(name = "restart_terminal_tab")
    @McpDescription(
        """
        |Restart the command running in the Terminal tabs `open_terminal_tab` marked with this kind and entry name: press
        |Ctrl-C, wait for it to stop, then send `command` to the same tab. If it does not stop within 5 seconds,
        |nothing is sent — that would start a second copy beside the first. The answer confirms the command was sent,
        |not that the shell accepted it: a line the user left half-typed in the tab can make the IDE drop it.
        """,
    )
    suspend fun restart_terminal_tab(
        @McpDescription("Kind of preset entry: config or custom") kind: String,
        @McpDescription("Name of the preset entry the tab was opened for") entryName: String,
        @McpDescription("Shell command line to execute in the tab once the old one has stopped") command: String,
    ): String {
        val stopped = interrupt(currentCoroutineContext().project, kind, entryName)
        if (stopped.isEmpty()) throw fail("\"$entryName\" is not running in a Terminal tab, so there is nothing to restart")
        withContext(Dispatchers.EDT) { stopped.forEach { it.sendCommandToExecute(command) } }
        return "stopped \"$entryName\" and sent its command again"
    }

    /**
     * Ctrl-C into every marked tab of this entry that has a command running, then wait until none
     * does. Returns the tabs that were stopped (empty when nothing was running).
     */
    private suspend fun interrupt(project: Project, kind: String, entryName: String): List<TerminalWidget> {
        if (kind !in TabMarks.KINDS) throw fail("kind must be one of ${TabMarks.KINDS}, got $kind")

        // The widgets are UI state, read on the EDT …
        val marked = withContext(Dispatchers.EDT) {
            TerminalToolWindowManager.getInstance(project).terminalWidgets
                .filter { widget -> TabMarks.get(widget)?.let { it.kind == kind && it.entryName == entryName } == true }
        }
        // … but isCommandRunning() must never run there: it asserts a background thread and may
        // inspect the process tree or show a modal progress to answer.
        val running = withContext(Dispatchers.IO) { marked.filter { it.isCommandRunning() } }
        if (running.isEmpty()) return running

        // Every tab is checked before any gets a Ctrl-C, so a failure here interrupts nothing.
        val ttys = running.map { it.ttyConnector ?: throw fail("the Terminal tab of \"$entryName\" has no terminal connected") }
        withContext(Dispatchers.EDT) { ttys.forEach { it.write(CTRL_C) } }

        withTimeoutOrNull(STOP_TIMEOUT_MS) {
            while (withContext(Dispatchers.IO) { running.any { it.isCommandRunning() } }) delay(POLL_MS)
        } ?: throw fail(
            "\"$entryName\" did not stop on Ctrl-C within ${STOP_TIMEOUT_MS / 1000}s — it is still running in its Terminal tab",
        )
        return running
    }

    private fun fail(text: String) = McpExpectedError(text, JsonObject(emptyMap()))

    private companion object {
        const val CTRL_C = "\u0003"

        /** How long a command gets to exit after Ctrl-C before it counts as not stopping. */
        const val STOP_TIMEOUT_MS = 5_000L

        const val POLL_MS = 100L
    }
}
