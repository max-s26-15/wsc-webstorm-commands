package dev.wsc.ide

import com.intellij.execution.ExecutionManager
import com.intellij.execution.RunManager
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentManager
import com.intellij.mcpserver.McpExpectedError
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.addJsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import org.jetbrains.plugins.terminal.TerminalToolWindowManager

/**
 * What `wsc --stop` and `wsc --restart` need from the IDE: what is running right now. The IDE's
 * own MCP Server has no tool that answers that, and `wsc` deliberately keeps no record of what it
 * launched — the IDE is the record. Which configuration a process runs comes from [RunRegistry].
 */
class WscControlToolset : McpToolset {

    @McpTool(name = "list_running")
    @McpDescription(
        """
        |List what is running in the project: run configurations with a live process in the Run or Debug tool window
        |(`runs`), and the Terminal tabs `open_terminal_tab` marked (`terminals`), each with whether a command is
        |running in it right now. Unmarked Terminal tabs are not listed, nor processes started before this plugin was loaded.
        """,
    )
    suspend fun list_running(): String {
        val project = currentCoroutineContext().project

        val runs = RunRegistry.getInstance(project).live().map { (_, run) -> run }
        // The tabs are UI state, read on the EDT.
        val marked = withContext(Dispatchers.EDT) {
            TerminalToolWindowManager.getInstance(project).terminalWidgets
                .mapNotNull { widget -> TabMarks.get(widget)?.let { widget to it } }
        }
        // Never on the EDT: isCommandRunning() asserts a background thread and may inspect the
        // process tree (`ps`) or show a modal progress to do it.
        val terminals = withContext(Dispatchers.IO) { marked.map { (widget, mark) -> mark to widget.isCommandRunning() } }

        return buildJsonObject {
            putJsonArray("runs") {
                for (run in runs) {
                    addJsonObject {
                        put("configurationName", run.name)
                        put("mode", if (run.debug) "debug" else "run")
                    }
                }
            }
            putJsonArray("terminals") {
                for ((mark, running) in terminals) {
                    addJsonObject {
                        put("entryName", mark.entryName)
                        put("kind", mark.kind)
                        put("mode", mark.mode)
                        mark.debugPort?.let { put("debugPort", it) }
                        put("commandRunning", running)
                    }
                }
            }
        }.toString()
    }

    @McpTool(name = "stop_run_configuration")
    @McpDescription(
        """
        |Stop every live process of a run configuration, the same as its Stop button; the Run or Debug tab stays open.
        |With `mode`, only the processes in that tool window. A configuration that is not running is not an error:
        |there is nothing left to stop.
        """,
    )
    suspend fun stop_run_configuration(
        @McpDescription("Name of the run configuration to stop") configurationName: String,
        @McpDescription("run or debug: only the processes in the Run or the Debug tool window (default: both)")
        mode: String? = null,
    ): String {
        val project = currentCoroutineContext().project
        checkMode(mode)

        val handlers = matching(project, configurationName, mode).map { (handler, _) -> handler }
        if (handlers.isEmpty()) return "\"$configurationName\" is not running"
        withContext(Dispatchers.EDT) { handlers.forEach { it.destroyProcess() } }

        // destroyProcess() only asks; the process is gone once its handler says so.
        withTimeoutOrNull(STOP_TIMEOUT_MS) {
            while (handlers.any { !it.isProcessTerminated }) delay(POLL_MS)
        } ?: throw fail("\"$configurationName\" did not stop within ${STOP_TIMEOUT_MS / 1000}s — stop it in the IDE")
        return "stopped \"$configurationName\""
    }

    @McpTool(name = "restart_run_configuration")
    @McpDescription(
        """
        |Restart every live process of a run configuration in its own Run or Debug tab, the same as its Rerun button:
        |each is stopped and started again with the same executor. With `mode`, only the processes in that tool window.
        |A restarted debug session has its breakpoints muted.
        """,
    )
    suspend fun restart_run_configuration(
        @McpDescription("Name of the running run configuration to restart") configurationName: String,
        @McpDescription("run or debug: only the processes in the Run or the Debug tool window (default: both)")
        mode: String? = null,
    ): String {
        val project = currentCoroutineContext().project
        checkMode(mode)

        // Every one of them, not the first: a configuration that allows parallel runs has one tab
        // per run, and a caller that names it once means all of them.
        val running = matching(project, configurationName, mode)
        if (running.isEmpty()) throw fail("\"$configurationName\" is not running, so there is nothing to restart")

        // Each completed by the IDE once its new process is up in its tab — as in debug_run_configuration.
        val restarts = withContext(Dispatchers.EDT) {
            val tabs = RunContentManager.getInstance(project).allDescriptors
            // Every environment is built before any process is restarted, so a refusal here
            // leaves all of them running instead of some.
            running.map { (handler, run) ->
                val settings = run.settings
                    ?: RunManager.getInstance(project).findConfigurationByName(configurationName)
                    ?: throw fail("No run configuration named \"$configurationName\" in ${project.name}")
                // contentToReuse is what keeps it the same tab, and what tells the IDE which
                // process the restart replaces; without it a second copy would start beside it.
                val descriptor = tabs.firstOrNull { it.processHandler === handler }
                    ?: throw fail("\"$configurationName\" cannot be restarted: its Run or Debug tab was not found")
                val started = CompletableDeferred<String>()
                val callback = ProgramRunner.Callback { tab -> started.complete(tab?.displayName ?: configurationName) }
                val environment = ExecutionEnvironmentBuilder.createOrNull(run.executor, settings)
                    ?.contentToReuse(descriptor)
                    ?.build(callback)
                    ?: throw fail("\"$configurationName\" cannot be restarted: the IDE could not build an execution environment")
                Restart(run, environment, started)
            }
        }
        // restartRunProfile is the Rerun button's own path, which stops the old process first
        // instead of asking whether to.
        withContext(Dispatchers.EDT) { restarts.forEach { ExecutionManager.getInstance(project).restartRunProfile(it.environment) } }

        val windows = restarts.map { if (it.run.debug) "Debug" else "Run" }.distinct()
        val tabs = withTimeoutOrNull(CONFIRM_TIMEOUT_MS) { restarts.map { it.started.await() } }
            ?: throw fail(
                "the IDE did not confirm within ${CONFIRM_TIMEOUT_MS / 1000}s that \"$configurationName\" restarted — " +
                    "check the ${windows.joinToString(" and ")} tool window",
            )
        restarts.zip(tabs).forEach { (restart, tab) ->
            if (restart.run.debug) DebugMute.muteFor(project, restart.environment.runProfile, tab)
        }
        return "restarted \"$configurationName\" (${windows.joinToString(", ") { it.lowercase() }})"
    }

    private class Restart(val run: RunRegistry.Run, val environment: ExecutionEnvironment, val started: CompletableDeferred<String>)

    /** The live processes of this configuration, in that tool window when `mode` names one. */
    private fun matching(project: Project, configurationName: String, mode: String?): List<Pair<ProcessHandler, RunRegistry.Run>> =
        RunRegistry.getInstance(project).live()
            .filter { (_, run) -> run.name == configurationName && (mode == null || (mode == "debug") == run.debug) }

    private fun fail(text: String) = McpExpectedError(text, JsonObject(emptyMap()))

    private fun checkMode(mode: String?) {
        if (mode != null && mode !in RUN_MODES) throw fail("mode must be one of $RUN_MODES, got $mode")
    }

    companion object {
        /** A process that has not stopped by now is not going to on its own. */
        const val STOP_TIMEOUT_MS = 10_000L

        /** A restart that has not produced its tab by now is not going to. */
        const val CONFIRM_TIMEOUT_MS = 10_000L

        const val POLL_MS = 100L

        /** The two tool windows a run configuration's process can be in. */
        val RUN_MODES = setOf("run", "debug")
    }
}
