package dev.wsc.ide

import com.intellij.execution.configurations.RunProfile
import com.intellij.openapi.application.EDT
import com.intellij.openapi.project.Project
import com.intellij.xdebugger.XDebugSession
import com.intellij.xdebugger.XDebuggerManager
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * A debug session `wsc` starts — or restarts — begins with breakpoints muted (the session's
 * "Mute Breakpoints" toggle); the user turns them back on in the Debug tab.
 */
object DebugMute {
    /**
     * Mute every debug session of `profile`, or the one whose tab is called `tabName`.
     *
     * Call it only once the IDE has confirmed the Debug tab: processStarted is published BEFORE
     * session.init(process), and muting there dereferences a null debug process. A breakpoint can
     * hit before this. Matched on sessionName rather than runContentDescriptor, which is forbidden
     * in split debugger mode.
     */
    suspend fun muteFor(project: Project, profile: RunProfile, tabName: String) {
        withContext(Dispatchers.EDT) {
            XDebuggerManager.getInstance(project).debugSessions
                .filter { it.runProfile === profile || it.sessionName == tabName }
                .forEach(::mute)
        }
    }

    private fun mute(session: XDebugSession) {
        if (!session.areBreakpointsMuted()) session.setBreakpointMuted(true)
    }
}
