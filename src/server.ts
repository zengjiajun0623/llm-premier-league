import http from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { summary, debateList, debateDetail, stats, verifiedSummary, gapTable, forecastView, agenticView } from "./api.js";
import { resultsDir, ROOT } from "./paths.js";

const PORT = Number(process.env.PORT ?? 5199);

// Data URLs look like static files ("/api/summary.json") so the same frontend
// works against this live server and against the static Vercel export.
const server = http.createServer((req, res) => {
  const url = req.url ?? "/";
  const json = (data: unknown, code = 200) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  };
  try {
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(ROOT, "public", "index.html")));
    } else if (url === "/api/live.json") {
      const p = join(resultsDir(), "live.json");
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(existsSync(p) ? readFileSync(p) : JSON.stringify({ status: "idle" }));
    } else if (url === "/api/summary.json") {
      json(summary());
    } else if (url === "/api/debates.json") {
      json(debateList());
    } else if (url.startsWith("/api/debate/") && url.endsWith(".json")) {
      const slug = url.slice("/api/debate/".length, -".json".length);
      const d = debateDetail(slug);
      json(d ?? { error: "not found" }, d ? 200 : 404);
    } else if (url === "/api/forecast.json") {
      json(forecastView(Date.now()));
    } else if (url === "/api/agentic.json") {
      json(agenticView(Date.now()));
    } else if (url === "/api/stats.json") {
      json(stats());
    } else if (url === "/api/verified.json") {
      json(verifiedSummary());
    } else if (url === "/api/gap.json") {
      json(gapTable());
    } else {
      res.writeHead(404);
      res.end("not found");
    }
  } catch (err) {
    console.error(`500 on ${url}: ${(err as Error).message}`);
    json({ error: "internal error" }, 500);
  }
});

server.listen(PORT, () => console.log(`LLM Premier League viewer on http://localhost:${PORT}`));
