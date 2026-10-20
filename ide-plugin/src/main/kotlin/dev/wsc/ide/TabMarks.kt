package dev.wsc.ide

import com.intellij.terminal.ui.TerminalWidget
import java.util.Collections
import java.util.WeakHashMap

/**
 * What `wsc` launched in a Terminal tab: the preset entry it belongs to, the entry's kind
 * (`config` — a run configuration, `custom` — the user's own commands) and the mode it was
 * launched in, plus the inspector port when it was debugged through the terminal.
 */
data class TabMark(val entryName: String, val kind: String, val mode: String, val debugPort: Int?)

/**
 * The marks on the Terminal tabs `open_terminal_tab` opened, which is how `wsc --stop` and
 * `--restart` tell their own tabs apart from everything else in the tool window.
 *
 * Keyed by the widget, not the tab title: a shell is free to retitle its tab (zsh often does,
 * from precmd), and the title is the one thing two different entries can share. Held in memory
 * only — nothing is written to disk — and weakly, so a closed tab takes its mark with it.
 */
object TabMarks {
    val KINDS = setOf("config", "custom")
    val MODES = setOf("run", "debug", "terminal")

    private val marks: MutableMap<TerminalWidget, TabMark> = Collections.synchronizedMap(WeakHashMap())

    fun put(widget: TerminalWidget, mark: TabMark) {
        marks[widget] = mark
    }

    fun get(widget: TerminalWidget): TabMark? = marks[widget]
}
