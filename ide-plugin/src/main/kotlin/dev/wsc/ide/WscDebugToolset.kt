package dev.wsc.ide

import com.intellij.execution.ProgramRunnerUtil
import com.intellij.execution.RunManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.runners.ExecutionEnvironmentBuilder
import com.intellij.execution.runners.ProgramRunner
import com.intellij.mcpserver.McpExpectedError
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.application.EDT
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject

/**
 * The one tool `wsc` needs and the IDE's own MCP Server does not offer: start a run configuration
 * in Debug mode. `execute_run_configuration` only ever uses the Run executor.
 */
class WscDebugToolset : McpToolset {

    @McpTool(name = "debug_run_configuration")
    @McpDescription(
        """
        |Start an existing run configuration with the Debug executor, the same as pressing its Debug button:
        |a Debug tab opens and the debugger attaches. Does not wait for the process to exit.
        |
        |Use a configuration name returned by `get_run_configurations`.
        """,
    )
    suspend fun debug_run_configuration(
        @McpDescription("Name of the existing run configuration to debug") configurationName: String,
    ): String {
        val project = currentCoroutineContext().project

        val settings = RunManager.getInstance(project).findConfigurationByName(configurationName)
            ?: throw fail("No run configuration named \"$configurationName\" in ${project.name}")

        val executor = DefaultDebugExecutor.getDebugExecutorInstance()

        // Not every configuration can be debugged (a plain shell script, say); the IDE greys out
        // the Debug button for those, and starting one would fail with a less useful message.
        if (ProgramRunner.getRunner(executor.id, settings.configuration) == null) {
            throw fail("\"$configurationName\" cannot be debugged: no debug runner accepts it")
        }

        // Completed by the IDE once the process is up and its Debug tab exists. It is what tells a
        // launch that worked from one the IDE quietly refused (a failed before-launch task, say).
        val started = CompletableDeferred<String>()
        val callback = ProgramRunner.Callback { descriptor ->
            started.complete(descriptor?.displayName ?: configurationName)
        }

        // Starting a run touches UI state; the IDE's own actions do it on the EDT.
        withContext(Dispatchers.EDT) {
            val environment = ExecutionEnvironmentBuilder.createOrNull(executor, settings)?.build()
                ?: throw fail("\"$configurationName\" cannot be debugged: the IDE could not build an execution environment")
            ProgramRunnerUtil.executeConfigurationAsync(environment, false, true, callback)
        }

        // An error, not a soft answer: wsc reports a tool failure against the configuration, and
        // "the IDE never confirmed" is exactly what a refused launch looks like from here.
        val tab = withTimeoutOrNull(CONFIRM_TIMEOUT_MS) { started.await() }
            ?: throw fail(
                "the IDE did not confirm within ${CONFIRM_TIMEOUT_MS / 1000}s that the debug session for " +
                    "\"$configurationName\" started — check the Debug tool window",
            )
        return "started a debug session for \"$configurationName\" (tab: $tab)"
    }

    private fun fail(text: String) = McpExpectedError(text, JsonObject(emptyMap()))

    private companion object {
        /** A debug launch that has not produced a tab by now is not going to. */
        const val CONFIRM_TIMEOUT_MS = 10_000L
    }
}
