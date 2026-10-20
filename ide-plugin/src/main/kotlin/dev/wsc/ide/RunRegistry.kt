package dev.wsc.ide

import com.intellij.execution.ExecutionListener
import com.intellij.execution.Executor
import com.intellij.execution.RunnerAndConfigurationSettings
import com.intellij.execution.executors.DefaultDebugExecutor
import com.intellij.execution.process.ProcessHandler
import com.intellij.execution.runners.ExecutionEnvironment
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import java.util.Collections
import java.util.WeakHashMap

/**
 * Which run configuration each live process of the project was started from, and with which
 * executor — recorded as the IDE starts it.
 *
 * A Run or Debug tab knows both only through internal API (`RunContentDescriptor.runConfigurationName`,
 * `ExecutionManager.getExecutors`), which the plugin verifier refuses and Marketplace flags;
 * [ExecutionListener] is the public way to learn them. The price: a process started before this
 * plugin was loaded — before a dynamic install or update — is not known here until it is started again.
 */
@Service(Service.Level.PROJECT)
class RunRegistry {

    /** One started process: its configuration's name, settings (null for a profile that has none) and executor. */
    class Run(val name: String, val settings: RunnerAndConfigurationSettings?, val executor: Executor) {
        val debug: Boolean get() = executor.id == DefaultDebugExecutor.EXECUTOR_ID
    }

    // Keyed weakly by the handler, and the value never points back at it, so a process the IDE
    // has let go of is let go of here too even if its termination was never heard.
    private val runs = Collections.synchronizedMap(WeakHashMap<ProcessHandler, Run>())

    fun started(env: ExecutionEnvironment, handler: ProcessHandler) {
        val settings = env.runnerAndConfigurationSettings
        runs[handler] = Run(settings?.name ?: env.runProfile.name, settings, env.executor)
    }

    fun terminated(handler: ProcessHandler) {
        runs.remove(handler)
    }

    /** Every recorded process that is still alive, with what it was started as. */
    fun live(): List<Pair<ProcessHandler, Run>> =
        synchronized(runs) { runs.entries.filter { !it.key.isProcessTerminated }.map { it.key to it.value } }

    companion object {
        fun getInstance(project: Project): RunRegistry = project.service()
    }
}

/** Feeds [RunRegistry]; registered as a project listener on [ExecutionListener]'s topic in plugin.xml. */
class RunRegistryListener(private val project: Project) : ExecutionListener {
    override fun processStarted(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler) {
        RunRegistry.getInstance(project).started(env, handler)
    }

    override fun processTerminated(executorId: String, env: ExecutionEnvironment, handler: ProcessHandler, exitCode: Int) {
        RunRegistry.getInstance(project).terminated(handler)
    }
}
