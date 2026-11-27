package com.ncm.phonebridge

import org.json.JSONArray
import org.json.JSONObject

data class LrcWord(val time: Long, val duration: Long, val text: String)

data class LrcLine(
    val time: Long,
    var text: String,
    var trans: String? = null,
    var words: List<LrcWord>? = null
)

object LrcParser {
    private val timeTag = Regex("\\[(\\d{1,3}):(\\d{1,2})(?:[.:](\\d{1,3}))?]")
    private val offsetTag = Regex("\\[offset:([+-]?\\d+)]", RegexOption.IGNORE_CASE)
    private val yrcHead = Regex("^\\[(\\d+),(\\d+)]")
    private val yrcWord = Regex("\\((\\d+),(\\d+),\\d+\\)([^()]*)")

    fun parse(lrc: String?, offsetMs: Long = 0L): MutableList<LrcLine> {
        val out = ArrayList<LrcLine>()
        if (lrc.isNullOrBlank()) return out
        var extra = 0L
        offsetTag.find(lrc)?.let { extra = it.groupValues[1].toLongOrNull() ?: 0L }
        for (raw in lrc.split('\n')) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val times = ArrayList<Long>()
            for (m in timeTag.findAll(line)) {
                val min = m.groupValues[1].toLongOrNull() ?: 0L
                val sec = m.groupValues[2].toLongOrNull() ?: 0L
                val frac = m.groupValues[3]
                var ms = 0L
                if (frac.isNotEmpty()) {
                    ms = when {
                        frac.length == 1 -> frac.toLong() * 100
                        frac.length == 2 -> frac.toLong() * 10
                        else -> frac.substring(0, 3).toLong()
                    }
                }
                times.add(min * 60000 + sec * 1000 + ms)
            }
            if (times.isEmpty()) continue
            val text = line.replace(timeTag, "").trim()
            for (t in times) out.add(LrcLine(t + offsetMs + extra, text))
        }
        out.sortBy { it.time }
        return out
    }

    /**
     * 解析网易云逐字歌词（YRC）。
     * 行格式：[lineStart,lineDuration](wordStart,wordDuration,flag)词(…)
     * 词时间既可能是相对行首的偏移，也可能是绝对毫秒，按行首做一次判定。
     */
    fun parseYrc(yrc: String?, offsetMs: Long = 0L): MutableList<LrcLine> {
        val out = ArrayList<LrcLine>()
        if (yrc.isNullOrBlank()) return out
        for (raw in yrc.split('\n')) {
            val line = raw.trim()
            if (line.isEmpty()) continue
            val head = yrcHead.find(line) ?: continue
            val lineStart = (head.groupValues[1].toLongOrNull() ?: 0L) + offsetMs
            val rest = line.substring(head.range.last + 1)
            val words = ArrayList<LrcWord>()
            for (m in yrcWord.findAll(rest)) {
                val rawStart = m.groupValues[1].toLongOrNull() ?: continue
                val dur = m.groupValues[2].toLongOrNull() ?: 0L
                val wordText = m.groupValues[3]
                if (wordText.isEmpty()) continue
                val start = if (rawStart < (head.groupValues[1].toLongOrNull() ?: 0L)) {
                    lineStart + rawStart
                } else {
                    rawStart + offsetMs
                }
                words.add(LrcWord(start, dur, wordText))
            }
            if (words.isEmpty()) continue
            out.add(LrcLine(lineStart, words.joinToString("") { it.text }, null, words))
        }
        out.sortBy { it.time }
        return out
    }

    fun mergeTranslation(main: List<LrcLine>, trans: List<LrcLine>, tolerance: Long = 60L) {
        if (main.isEmpty() || trans.isEmpty()) return
        val pool = trans.sortedBy { it.time }
        var cursor = 0
        for (line in main) {
            while (cursor < pool.size && pool[cursor].time < line.time - tolerance) cursor++
            if (cursor < pool.size && kotlin.math.abs(pool[cursor].time - line.time) <= tolerance) {
                if (pool[cursor].text.isNotBlank()) line.trans = pool[cursor].text
            }
        }
    }

    fun toJson(lines: List<LrcLine>): JSONArray {
        val arr = JSONArray()
        for (l in lines) {
            val o = JSONObject()
            o.put("t", l.time)
            o.put("x", l.text)
            if (!l.trans.isNullOrBlank()) o.put("r", l.trans)
            l.words?.let { ws ->
                if (ws.isNotEmpty()) {
                    val wa = JSONArray()
                    for (w in ws) {
                        wa.put(JSONObject().put("t", w.time).put("d", w.duration).put("x", w.text))
                    }
                    o.put("w", wa)
                }
            }
            arr.put(o)
        }
        return arr
    }
}
