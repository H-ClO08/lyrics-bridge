package com.ncm.phonebridge;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.math.BigInteger;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import javax.crypto.Cipher;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 网易云网页端私有接口的加密层（weapi）。
 *
 * 为什么要这一层：搜索 / 歌词 / 封面都是匿名公开接口，但「我喜欢的音乐」是账号数据，
 * 写操作必须携带登录态，并且请求体要经过 AES-128-CBC 两层加密 + RSA 加密随机密钥。
 *
 * 这段代码刻意写成**纯 Java、零 Android 依赖**：这样可以在电脑上用 javac 单独编译，
 * 直接对着真实接口跑一遍验证加密是否正确，不必等装到手机上才发现。
 *
 * 与桌面版 src/netease-account.js 的 weapi() 逐字段对齐（同一组常量、同一个加密顺序）。
 */
public final class Weapi {

    private static final String NONCE = "0CoJUm6Qyw8W8jud";
    private static final String PUBKEY = "010001";
    private static final String MODULUS =
            "00e0b509f6259df8642dbc35662901477df22677ec152b5ff68ace615bb7b725152b3ab17a876aea8a5aa76d2e4176"
            + "29ec4ee341f56135fccf695280104e0312ecbda92557c93870114af6c9d05c4f7f0c3685b7a46bee255932575cc"
            + "e10b424d813cfe4875d3e82047b97ddef52741d546b8e289dc6935b3ece0462db0a22b8e7";
    private static final byte[] IV = "0102030405060708".getBytes(StandardCharsets.UTF_8);
    private static final String CHARS = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

    public static final String BASE = "https://music.163.com";
    public static final String UA =
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) "
            + "Chrome/122.0.0.0 Safari/537.36";
    public static final String ANON_COOKIE = "appver=2.10.6; os=pc;";

    private static final SecureRandom RANDOM = new SecureRandom();

    private Weapi() {
    }

    /** 一层 AES-128-CBC，PKCS#7 填充，输出 base64。 */
    private static String aesEncrypt(String text, String key) throws Exception {
        Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
        SecretKeySpec ks = new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES");
        cipher.init(Cipher.ENCRYPT_MODE, ks, new IvParameterSpec(IV));
        byte[] out = cipher.doFinal(text.getBytes(StandardCharsets.UTF_8));
        return androidlessBase64(out);
    }

    /**
     * RSA：把 16 字节随机密钥**倒序**当大整数，做 pubKey 次方的模幂。
     * 直接 BigInteger.modPow 就是它，不用自己写快速幂。
     */
    private static String rsaEncrypt(String secret) {
        byte[] raw = secret.getBytes(StandardCharsets.UTF_8);
        byte[] reversed = new byte[raw.length];
        for (int i = 0; i < raw.length; i++) reversed[i] = raw[raw.length - 1 - i];

        BigInteger m = new BigInteger(MODULUS, 16);
        BigInteger base = new BigInteger(1, reversed);
        BigInteger exp = new BigInteger(PUBKEY, 16);
        String hex = base.modPow(exp, m).toString(16);
        StringBuilder sb = new StringBuilder();
        for (int i = hex.length(); i < 256; i++) sb.append('0');
        return sb.append(hex).toString();
    }

    private static String randomSecret() {
        StringBuilder sb = new StringBuilder(16);
        for (int i = 0; i < 16; i++) sb.append(CHARS.charAt(RANDOM.nextInt(CHARS.length())));
        return sb.toString();
    }

    /**
     * 把一段 JSON 变成 weapi 需要的两个字段。
     * 顺序和桌面版一致：先用自己的固定 key 加密，再用随机 key 加密一次；随机 key 用 RSA 保护。
     */
    public static String[] encrypt(String json) throws Exception {
        String secret = randomSecret();
        String first = aesEncrypt(json, NONCE);
        String params = aesEncrypt(first, secret);
        return new String[]{params, rsaEncrypt(secret)};
    }

    public static final class Response {
        public final int status;
        public final String body;
        /** 服务端下发的全部 Set-Cookie，已用 "; " 拼好 */
        public final String setCookie;

        Response(int status, String body, String setCookie) {
            this.status = status;
            this.body = body;
            this.setCookie = setCookie;
        }
    }

    /** POST 一个 weapi 请求。payload 里的值必须是字符串。 */
    public static Response post(String path, Map<String, String> payload, String cookie) throws IOException {
        StringBuilder json = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, String> e : payload.entrySet()) {
            if (!first) json.append(',');
            first = false;
            json.append('"').append(escape(e.getKey())).append("\":\"").append(escape(e.getValue())).append('"');
        }
        json.append('}');

        String[] enc;
        try {
            enc = encrypt(json.toString());
        } catch (Exception e) {
            throw new IOException("加密失败: " + e.getMessage(), e);
        }

        String form = "params=" + URLEncoder.encode(enc[0], "UTF-8")
                + "&encSecKey=" + URLEncoder.encode(enc[1], "UTF-8");

        return request(BASE + path + "?csrf_token=", "POST", form, cookie);
    }

    /** GET 一个普通接口（账号信息、歌单详情这类不需要加密的）。 */
    public static Response get(String url, String cookie) throws IOException {
        return request(url, "GET", null, cookie);
    }

    private static Response request(String url, String method, String body, String cookie) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(url).openConnection();
        try {
            conn.setRequestMethod(method);
            conn.setConnectTimeout(10000);
            conn.setReadTimeout(10000);
            conn.setRequestProperty("User-Agent", UA);
            conn.setRequestProperty("Referer", BASE + "/");
            conn.setRequestProperty("Origin", BASE);
            conn.setRequestProperty("Cookie", cookie == null || cookie.isEmpty() ? ANON_COOKIE : cookie);
            if (body != null) {
                byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                conn.setFixedLengthStreamingMode(bytes.length);
                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bytes);
                }
            }

            int status = conn.getResponseCode();
            InputStream in = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
            String text = in == null ? "" : readAll(in);

            List<String> jar = new ArrayList<>();
            for (Map.Entry<String, List<String>> e : conn.getHeaderFields().entrySet()) {
                if (e.getKey() != null && e.getKey().equalsIgnoreCase("Set-Cookie")) {
                    for (String v : e.getValue()) jar.add(v);
                }
            }
            return new Response(status, text, String.join("; ", jar));
        } finally {
            conn.disconnect();
        }
    }

    private static String readAll(InputStream in) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int n;
        while ((n = in.read(buf)) > 0) out.write(buf, 0, n);
        in.close();
        return out.toString("UTF-8");
    }

    private static String escape(String s) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.toString();
    }

    /**
     * 自己实现 base64，是为了让这个文件能脱离 Android 用 javac 直接编译验证
     * （java.util.Base64 在 Android 上是 API 26+，这里也不依赖它，更省心）。
     */
    private static final char[] B64 =
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/".toCharArray();

    static String androidlessBase64(byte[] data) {
        StringBuilder sb = new StringBuilder((data.length + 2) / 3 * 4);
        int i = 0;
        while (i + 2 < data.length) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8) | (data[i + 2] & 0xff);
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63])
              .append(B64[(n >> 6) & 63]).append(B64[n & 63]);
            i += 3;
        }
        int rem = data.length - i;
        if (rem == 1) {
            int n = (data[i] & 0xff) << 16;
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63]).append("==");
        } else if (rem == 2) {
            int n = ((data[i] & 0xff) << 16) | ((data[i + 1] & 0xff) << 8);
            sb.append(B64[(n >> 18) & 63]).append(B64[(n >> 12) & 63])
              .append(B64[(n >> 6) & 63]).append('=');
        }
        return sb.toString();
    }
}
