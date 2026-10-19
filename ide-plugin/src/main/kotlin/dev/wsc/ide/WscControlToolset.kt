package dev.wsc.ide

import com.intellij.execution.ExecutionManager
import com.intellij.execution.RunManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.executors.DefaultRunExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.execution.ui.RunContentDescriptor
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
 * launched — the IDE is the record.
 */
class WscControlToolset : McpToolset {

    @McpTool(name = "list_running")
    @McpDescription(
        """
        |List what is running in the project: run configurations with a live process in the Run or Debug tool window
        |(`runs`), and the Terminal tabs `open_terminal_tab` marked (`terminals`), each with whether a command is
        |running in it right now. Unmarked Terminal tabs are not listed.
        """,
    )
    suspend fun list_running(): String {
        val project = currentCoroutineContext().project

        // Both halves read UI state, which the IDE keeps on the EDT.
        return withContext(Dispatchers.EDT) {
            buildJsonObject {
                putJsonArray("runs") {
                    for (descriptor in liveDescriptors(project)) {
                        addJsonObject {
                            put("configurationName", descriptor.runConfigurationName)
                            put("mode", if (isDebug(project, descriptor)) "debug" else "run")
                        }
                    }
                }
                putJsonArray("terminals") {
                    for (widget in TerminalToolWindowManager.getInstance(project).terminalWidgets) {
                        val mark = TabMarks.get(widget) ?: continue
                        addJsonObject {
                            put("entryName", mark.entryName)
                            put("kind", mark.kind)
                            put("mode", mark.mode)
                            mark.debugPort?.let { put("debugPort", it) }
                            put("commandRunning", widget.isCommandRunning())
                        }
                    }
                }
            }.toString()
        }
    }

    @McpTool(name = "stop_run_configuration")
    @McpDescription(
        """
        |Stop every live process of a run configuration, the same as its Stop button; the Run or Debug tab stays open.
        |A configuration that is not running is not an error: there is nothing left to stop.
        """,
    )
    suspend fun stop_run_configuration(
        @McpDescription("Name of the run configuration to stop") configurationName: String,
    ): String {
        val project = currentCoroutineContext().project

        val handlers = withContext(Dispatchers.EDT) {
            liveDescriptors(project)
                .filter { it.runConfigurationName == configurationName }
                .mapNotNull { it.processHandler }
                .onEach { it.destroyProcess() }
        }
        if (handlers.isEmpty()) return "\"$configurationName\" is not running"

        // destroyProcess() only asks; the process is gone once its handler says so.
        withTimeoutOrNull(STOP_TIMEOUT_MS) {
            while (handlers.any { !it.isProcessTerminated }) delay(POLL_MS)
        } ?: throw fail("\"$configurationName\" did not stop within ${STOP_TIMEOUT_MS / 1000}s — stop it in the IDE")
        return "stopped \"$configurationName\""
    }

    @McpTool(name = "restart_run_configuration")
    @McpDescription(
        """
        |Restart a running run configuration in the same Run or Debug tab, the same as its Rerun button: the process is
        |stopped and started again with the same executor. A restarted debug session has its breakpoints muted.
        """,
    )
    suspend fun restart_run_configuration(
        @McpDescription("Name of the running run configuration to restart") configurationName: String,
    ): String {
        val project = currentCoroutineContext().project

        val (descriptor, debug) = withContext(Dispatchers.EDT) {
            liveDescriptors(project)
                .firstOrNull { it.runConfigurationName == configurationName }
                ?.let { it to isDebug(project, it) }
        } ?: throw fail("\"$configurationName\" is not running, so there is nothing to restart")

        val settings = RunManager.getInstance(project).findConfigurationByName(configurationName)
            ?: throw fail("No run configuration named \"$configurationName\" in ${project.name}")
        val executor = if (debug) DefaultDebugExecutor.getDebugExecutorInstance() else DefaultRunExecutor.getRunExecutorInstance()

        // Completed by the IDE once the new process is up in its tab — as in debug_run_configuration.
        val started = CompletableDeferred<String>()
        val callback = ProgramRunner.Callback { tab -> started.complete(tab?.displayName ?: configurationName) }

        withContext(Dispatchers.EDT) {
            // contentToReuse is what keeps it the same tab; restartRunProfile is the Rerun button's
            // own path, which stops the old process first instead of asking whether to.
            val environment = ExecutionEnvironmentBuilder.createOrNull(executor, settings)
                ?.contentToReuse(descriptor)
                ?.build(callback)
                ?: throw fail("\"$configurationName\" cannot be restarted: the IDE could not build an execution environment")
            ExecutionManager.getInstance(project).restartRunProfile(environment)
        }

        val window = if (debug) "Debug" else "Run"
        val tab = withTimeoutOrNull(CONFIRM_TIMEOUT_MS) { started.await() }
            ?: throw fail(
                "the IDE did not confirm within ${CONFIRM_TIMEOUT_MS / 1000}s that \"$configurationName\" restarted — " +
                    "check the $window tool window",
            )
        if (debug) DebugMute.muteFor(project, settings.configuration, tab)
        return "restarted \"$configurationName\" (${window.lowercase()})"
    }

    private fun fail(text: String) = McpExpectedError(text, JsonObject(emptyMap()))

    companion object {
        /** A process that has not stopped by now is not going to on its own. */
        const val STOP_TIMEOUT_MS = 10_000L

        /** A restart that has not produced its tab by now is not going to. */
        const val CONFIRM_TIMEOUT_MS = 10_000L

        const val POLL_MS = 100L

        /** Run/Debug tabs of a run configuration whose process is still alive. */
        fun liveDescriptors(project: Project): List<RunContentDescriptor> =
            ExecutionManager.getInstance(project).getRunningDescriptors { true }.filter {
                it.runConfigurationName != null && it.processHandler?.isProcessTerminated == false
            }

        fun isDebug(project: Project, descriptor: RunContentDescriptor): Boolean =
            ExecutionManager.getInstance(project).getExecutors(descriptor)
                .any { it.id == DefaultDebugExecutor.EXECUTOR_ID }
    }
}
