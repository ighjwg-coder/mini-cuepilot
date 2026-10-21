package com.camcue.app

import org.json.JSONObject
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.HttpURLConnection
import java.net.Inet4Address
import java.net.InetAddress
import java.net.NetworkInterface
import java.net.SocketTimeoutException
import java.net.URL
import java.util.Collections
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/** 찾은 CamCue 서버 */
data class Server(
    val name: String,
    val host: String,
    val port: Int,
    val version: String,
    val proto: String = "http",
) {
    val baseUrl get() = "$proto://$host:$port"
    val address get() = "$host:$port"
}

/**
 * 같은 Wi-Fi 의 CamCue 서버 찾기.
 *  1) UDP 브로드캐스트 "CAMCUE_DISCOVER" → 서버가 JSON 으로 응답 (빠름, 포트가 바뀌어도 찾음)
 *  2) 응답이 없으면 같은 대역(/24)의 기본 포트에 HTTP /api/health 확인 (공유기가 브로드캐스트를 막는 경우)
 * 모두 백그라운드 스레드에서 호출할 것.
 */
object Discovery {
    const val DISCOVERY_PORT = 38089
    private const val QUERY = "CAMCUE_DISCOVER"

    /** 서버가 포트를 자동 변경할 때 쓰는 순서와 같음 (서버 listen.ts) */
    val HTTP_PORTS = listOf(38080, 38090, 28080, 18080, 48080)

    fun find(timeoutMs: Int = 1500): List<Server> {
        val found = udp(timeoutMs)
        if (found.isNotEmpty()) return found
        return scan(HTTP_PORTS.take(2))
    }

    /** 이 폰의 IPv4 주소와 브로드캐스트 주소 */
    private fun localIpv4(): List<Pair<Inet4Address, InetAddress?>> {
        val out = mutableListOf<Pair<Inet4Address, InetAddress?>>()
        try {
            for (nif in Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!nif.isUp || nif.isLoopback) continue
                for (ia in nif.interfaceAddresses) {
                    val addr = ia.address
                    if (addr is Inet4Address && !addr.isLoopbackAddress) out += addr to ia.broadcast
                }
            }
        } catch (_: Exception) {
        }
        return out
    }

    fun udp(timeoutMs: Int): List<Server> {
        val result = LinkedHashMap<String, Server>()
        try {
            DatagramSocket().use { sock ->
                sock.broadcast = true
                sock.soTimeout = 250
                val targets = LinkedHashSet<InetAddress>()
                targets += InetAddress.getByName("255.255.255.255")
                localIpv4().mapNotNullTo(targets) { it.second }
                val query = QUERY.toByteArray()
                val buf = ByteArray(2048)
                val end = System.currentTimeMillis() + timeoutMs
                var lastSend = 0L
                var sends = 0
                while (System.currentTimeMillis() < end) {
                    // 패킷 손실 대비 3번까지 다시 보냄
                    if (sends < 3 && System.currentTimeMillis() - lastSend > 400) {
                        for (t in targets) {
                            try {
                                sock.send(DatagramPacket(query, query.size, t, DISCOVERY_PORT))
                            } catch (_: Exception) {
                            }
                        }
                        lastSend = System.currentTimeMillis()
                        sends++
                    }
                    try {
                        val pkt = DatagramPacket(buf, buf.size)
                        sock.receive(pkt)
                        val json = JSONObject(String(pkt.data, 0, pkt.length, Charsets.UTF_8))
                        val host = pkt.address.hostAddress
                        if (json.optString("app") != "CamCue" || host == null) continue
                        val s = Server(
                            name = json.optString("name", "CamCue"),
                            host = host,
                            port = json.optInt("port", 38080),
                            version = json.optString("version", ""),
                            proto = json.optString("proto", "http"),
                        )
                        result[s.address] = s
                    } catch (_: SocketTimeoutException) {
                    } catch (_: Exception) {
                    }
                }
            }
        } catch (_: Exception) {
        }
        return result.values.toList()
    }

    /** 같은 /24 대역 전체에 HTTP 확인 (약 2~4초) */
    fun scan(ports: List<Int>): List<Server> {
        val bases = localIpv4()
            .map { it.first.hostAddress ?: "" }
            .filter { it.count { c -> c == '.' } == 3 }
            .map { it.substringBeforeLast('.') }
            .distinct()
        if (bases.isEmpty()) return emptyList()
        val found = ConcurrentHashMap<String, Server>()
        val pool = Executors.newFixedThreadPool(48)
        for (base in bases) for (i in 1..254) for (port in ports) {
            pool.execute { check("$base.$i", port, 400)?.let { found[it.address] = it } }
        }
        pool.shutdown()
        pool.awaitTermination(15, TimeUnit.SECONDS)
        return found.values.sortedBy { it.host }
    }

    /** host:port 가 CamCue 서버면 정보 반환 */
    fun check(host: String, port: Int, timeoutMs: Int = 1500): Server? {
        return try {
            val conn = URL("http://$host:$port/api/health").openConnection() as HttpURLConnection
            conn.connectTimeout = timeoutMs
            conn.readTimeout = timeoutMs
            try {
                if (conn.responseCode != 200) return null
                val json = JSONObject(conn.inputStream.bufferedReader().readText())
                // v0.0.3 이하 서버는 app 필드가 없음 → ok + version 으로 판단
                val isCamCue = json.optString("app") == "CamCue" || (json.optBoolean("ok") && json.has("version") && json.has("wsClients"))
                if (!isCamCue) null
                else Server(json.optString("name", host), host, port, json.optString("version", ""))
            } finally {
                conn.disconnect()
            }
        } catch (_: Exception) {
            null
        }
    }

    /** "192.168.0.10" 또는 "192.168.0.10:38090" 직접 입력 → 확인 */
    fun checkManual(input: String): Server? {
        val text = input.trim().removePrefix("http://").removeSuffix("/")
        if (text.isEmpty()) return null
        val host = text.substringBefore(':')
        val port = text.substringAfter(':', "").toIntOrNull()
        if (port != null) return check(host, port)
        for (p in HTTP_PORTS) check(host, p, 1000)?.let { return it }
        return null
    }
}
