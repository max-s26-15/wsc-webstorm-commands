package dev.wsc.ide

import com.intellij.execution.ExecutionManager
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.ui.RunContentDescriptor
import com.intellij.mcpserver.McpToolset
import com.intellij.mcpserver.annotations.McpDescription
import com.intellij.mcpserver.annotations.McpTool
import com.intellij.mcpserver.project
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.withContext
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

    companion object {
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
