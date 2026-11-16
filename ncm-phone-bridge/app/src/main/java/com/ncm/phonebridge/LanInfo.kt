package com.ncm.phonebridge

import java.net.Inet4Address
import java.net.NetworkInterface

object LanInfo {
    fun localIpv4(): String? {
        try {
            val nifs = NetworkInterface.getNetworkInterfaces()
            val preferred = ArrayList<String>()
            val fallback = ArrayList<String>()
            for (nif in nifs) {
                if (!nif.isUp || nif.isLoopback) continue
                for (addr in nif.inetAddresses) {
                    if (addr is Inet4Address && !addr.isLoopbackAddress && !addr.isLinkLocalAddress) {
                        val ip = addr.hostAddress ?: continue
                        fallback.add(ip)
                        if (ip.startsWith("192.168.") || ip.startsWith("10.") || ip.startsWith("172.")) {
                            preferred.add(ip)
                        }
                    }
                }
            }
            preferred.firstOrNull()?.let { return it }
            fallback.firstOrNull()?.let { return it }
        } catch (e: Exception) {
        }
        return null
    }

    fun url(port: Int): String = "http://${localIpv4() ?: "手机IP"}:$port"
}
