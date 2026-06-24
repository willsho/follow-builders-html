#!/usr/bin/env node
/* Tiny static file server for local preview of the public/ dir. */
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(process.env.PUBLIC_DIR || "public");
const PORT = Number(process.env.PORT || 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
};

http
  .createServer((req, res) => {
    const urlPath = decodeURIComponent(req.url.split("?")[0]);
    let file = path.join(ROOT, urlPath === "/" ? "index.html" : urlPath);
    if (!file.startsWith(ROOT)) {
      res.writeHead(403).end("forbidden");
      return;
    }
    fs.stat(file, (err, stat) => {
      if (err) {
        res.writeHead(404).end("not found");
        return;
      }
      if (stat.isDirectory()) file = path.join(file, "index.html");
      fs.readFile(file, (e, buf) => {
        if (e) {
          res.writeHead(404).end("not found");
          return;
        }
        res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
        res.end(buf);
      });
    });
  })
  .listen(PORT, () => console.log(`serving ${ROOT} at http://localhost:${PORT}`));
