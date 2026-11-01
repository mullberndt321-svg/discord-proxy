#!/usr/bin/env node
/**
 * Discord Web-Proxy (Node.js 18+, keine Abhängigkeiten)
 *
 *   /                 -> Startseite (public/index.html)
 *   /_cdn/...         -> cdn.discordapp.com
 *   /_media/...       -> media.discordapp.net
 *   /_gw (WebSocket)  -> gateway.discord.gg
 *   alles andere      -> discord.com
 *
 * Start:  node server.js      (PORT=8080 ist Standard)
 */

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const PORT = process.env.PORT || 8080;
const INDEX = fs.readFileSync(path.join(__dirname, "public", "index.html"));

const ROUTES = [
  { prefix: "/_cdn", host: "cdn.discordapp.com" },
  { prefix: "/_media", host: "media.discordapp.net" },
];

function resolveUpstream(url) {
  for (const r of ROUTES) {
    if (url === r.prefix || url.startsWith(r.prefix + "/")) {
      return { host: r.host, path: url.slice(r.prefix.length) || "/" };
    }
  }
  return { host: "discord.com", path: url };
}

// Ersetzt Discord-URLs in Antworten durch die Adresse dieses Proxys
function rewrite(text, host, secure) {
  const http_ = secure ? "https" : "http";
  const ws = secure ? "wss" : "ws";
  return text
    .replace(/wss:\/\/gateway\.discord\.gg/g, `${ws}://${host}/_gw`)
    .replace(/https:\/\/cdn\.discordapp\.com/g, `${http_}://${host}/_cdn`)
    .replace(/https:\/\/media\.discordapp\.net/g, `${http_}://${host}/_media`)
    .replace(/\/\/cdn\.discordapp\.com/g, `//${host}/_cdn`)
    .replace(/\/\/media\.discordapp\.net/g, `//${host}/_media`)
    .replace(/\/\/gateway\.discord\.gg/g, `//${host}/_gw`)
    .replace(/https:\/\/discord\.com/g, `${http_}://${host}`)
    .replace(/\/\/discord\.com/g, `//${host}`);
}

const REWRITABLE = /(text\/html|javascript|text\/css|application\/json|manifest)/i;

function decode(buf, encoding) {
  switch ((encoding || "").toLowerCase()) {
    case "gzip": return zlib.gunzipSync(buf);
    case "br": return zlib.brotliDecompressSync(buf);
    case "deflate": return zlib.inflateSync(buf);
    default: return buf;
  }
}

const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return res.end(INDEX);
  }

  const myHost = req.headers.host;
  const secure = (req.headers["x-forwarded-proto"] || "http") === "https";
  const up = resolveUpstream(req.url);

  const headers = { ...req.headers, host: up.host, "accept-encoding": "identity" };
  headers.origin = "https://discord.com";
  if (headers.referer) headers.referer = "https://discord.com/";
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];

  const upstream = https.request(
    { hostname: up.host, port: 443, path: up.path, method: req.method, headers },
    (upRes) => {
      const out = { ...upRes.headers };
      // Sicherheits-Header entfernen, die das Laden über den Proxy verhindern würden
      delete out["content-security-policy"];
      delete out["content-security-policy-report-only"];
      delete out["x-frame-options"];
      delete out["strict-transport-security"];

      // Cookies an die Proxy-Domain binden
      if (out["set-cookie"]) {
        out["set-cookie"] = out["set-cookie"].map((c) =>
          c.replace(/;\s*Domain=[^;]*/i, "").replace(/;\s*SameSite=None/i, "; SameSite=Lax")
        );
      }
      // Weiterleitungen umschreiben
      if (out.location) out.location = rewrite(out.location, myHost, secure);

      const type = out["content-type"] || "";
      if (!REWRITABLE.test(type)) {
        res.writeHead(upRes.statusCode, out);
        return upRes.pipe(res);
      }

      const chunks = [];
      upRes.on("data", (c) => chunks.push(c));
      upRes.on("end", () => {
        try {
          const raw = decode(Buffer.concat(chunks), out["content-encoding"]);
          const body = Buffer.from(rewrite(raw.toString("utf8"), myHost, secure));
          delete out["content-encoding"];
          out["content-length"] = body.length;
          res.writeHead(upRes.statusCode, out);
          res.end(body);
        } catch (err) {
          res.writeHead(502, { "content-type": "text/plain" });
          res.end("Fehler beim Verarbeiten der Antwort: " + err.message);
        }
      });
    }
  );

  upstream.setTimeout(30000, () => upstream.destroy(new Error("Upstream-Timeout")));
  upstream.on("error", (err) => {
    console.error(`[proxy] ${req.method} ${req.url} -> ${err.message}`);
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain" });
    res.end("Bad Gateway: " + err.message);
  });

  req.pipe(upstream);
});

// WebSocket-Tunnel zum Discord-Gateway
server.on("upgrade", (req, socket, head) => {
  if (!req.url.startsWith("/_gw")) return socket.destroy();

  const upReq = https.request({
    hostname: "gateway.discord.gg",
    port: 443,
    path: req.url.slice("/_gw".length) || "/",
    method: "GET",
    headers: { ...req.headers, host: "gateway.discord.gg", origin: "https://discord.com" },
  });

  upReq.on("upgrade", (upRes, upSocket, upHead) => {
    const lines = Object.entries(upRes.headers).map(([k, v]) => `${k}: ${v}`);
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${lines.join("\r\n")}\r\n\r\n`);
    if (upHead && upHead.length) socket.write(upHead);
    upSocket.pipe(socket);
    socket.pipe(upSocket);
    upSocket.on("error", () => socket.destroy());
    socket.on("error", () => upSocket.destroy());
  });
  upReq.on("response", () => socket.destroy());
  upReq.on("error", () => socket.destroy());
  upReq.end(head);
});

server.listen(PORT, () => console.log(`Discord-Proxy läuft auf http://localhost:${PORT}`));
