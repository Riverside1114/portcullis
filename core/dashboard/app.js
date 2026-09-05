const el = (id) => document.getElementById(id);

const ui = {
  server: el("server"),
  live: el("live"),
  refresh: el("refresh"),
  tiles: el("tiles"),
  rows: el("rows"),
  empty: el("empty"),
  methods: el("methods"),
  q: el("q"),
  kind: el("kind"),
  dir: el("dir"),
  detail: el("detail"),
  detailTitle: el("detail-title"),
  detailMeta: el("detail-meta"),
  detailBody: el("detail-body"),
  detailClose: el("detail-close"),
};

const state = {
  server: null,
  records: [],
  selectedSeq: null,
  stream: null,
};

const MAX_ROWS = 2000;

async function api(path) {
  const response = await fetch(path, { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

function filters() {
  const params = new URLSearchParams({ limit: String(MAX_ROWS) });
  if (ui.q.value.trim()) params.set("q", ui.q.value.trim());
  if (ui.kind.value) params.set("kind", ui.kind.value);
  if (ui.dir.value) params.set("dir", ui.dir.value);
  return params;
}

function matchesFilters(record) {
  if (ui.kind.value && record.kind !== ui.kind.value) return false;
  if (ui.dir.value && record.dir !== ui.dir.value) return false;
  const search = ui.q.value.trim().toLowerCase();
  if (search) {
    const haystack = `${record.method ?? ""} ${record.reason ?? ""}`.toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  return true;
}

async function loadServers() {
  const servers = await api("/api/servers");

  if (servers.length === 0) {
    ui.server.innerHTML = '<option value="">no logs yet</option>';
    showEmpty("Nothing recorded yet. Wrap a server with portcullis run and traffic will show up here.");
    return;
  }

  const previous = state.server;
  ui.server.innerHTML = servers
    .map((s) => `<option value="${escapeAttr(s.name)}">${escapeHtml(s.name)}</option>`)
    .join("");

  state.server = servers.some((s) => s.name === previous) ? previous : servers[0].name;
  ui.server.value = state.server;
  await load();
}

async function load() {
  if (!state.server) return;

  const [page, stats] = await Promise.all([
    api(`/api/log/${encodeURIComponent(state.server)}?${filters()}`),
    api(`/api/stats/${encodeURIComponent(state.server)}`),
  ]);

  state.records = page.records;
  renderTiles(stats, page);
  renderMethods(stats.methods);
  renderRows();
}

function renderTiles(stats, page) {
  const errorRate = stats.calls > 0 ? (stats.errors / stats.calls) * 100 : 0;

  const tiles = [
    ["Messages", stats.total.toLocaleString()],
    ["Calls", stats.calls.toLocaleString()],
    ["Errors", stats.errors.toLocaleString(), stats.errors > 0 ? "bad" : ""],
    ["Error rate", `${errorRate.toFixed(1)}%`, errorRate > 5 ? "bad" : ""],
    ["Malformed", stats.malformed.toLocaleString(), stats.malformed > 0 ? "warn" : ""],
    ["Sessions", stats.sessions.toLocaleString()],
    ["Traffic", formatBytes(stats.bytes)],
    ["Showing", `${page.records.length.toLocaleString()} / ${page.matched.toLocaleString()}`],
  ];

  ui.tiles.innerHTML = tiles
    .map(
      ([k, v, cls = ""]) =>
        `<div class="tile"><div class="k">${k}</div><div class="v ${cls}">${v}</div></div>`,
    )
    .join("");
}

function renderMethods(methods) {
  if (methods.length === 0) {
    ui.methods.innerHTML = '<p class="empty" style="padding:0">No calls yet.</p>';
    return;
  }

  ui.methods.innerHTML = methods
    .slice(0, 24)
    .map(
      (m) => `
      <button class="method-row" data-method="${escapeAttr(m.method)}" type="button">
        <span class="name" title="${escapeAttr(m.method)}">${escapeHtml(m.method)}</span>
        <span class="n">${m.calls}</span>
        <span class="p95">p50 ${m.p50}ms &middot; p95 ${m.p95}ms${
          m.errors > 0 ? ` &middot; ${m.errors} err` : ""
        }</span>
      </button>`,
    )
    .join("");
}

function renderRows() {
  if (state.records.length === 0) {
    ui.rows.innerHTML = "";
    showEmpty("No records match these filters.");
    return;
  }

  ui.empty.hidden = true;

  const fragment = document.createDocumentFragment();
  for (const record of state.records) {
    fragment.appendChild(rowFor(record));
  }
  ui.rows.replaceChildren(fragment);
}

function rowFor(record) {
  const tr = document.createElement("tr");
  tr.dataset.seq = String(record.seq);
  if (record.seq === state.selectedSeq) tr.className = "selected";

  const slow = record.ms !== undefined && record.ms > 1000;

  tr.innerHTML = `
    <td class="c-time">${record.ts.slice(11, 23)}</td>
    <td class="c-dir">${record.dir === "to-server" ? "&rarr;" : "&larr;"}</td>
    <td class="c-method" title="${escapeAttr(record.method ?? record.reason ?? "")}">${escapeHtml(
      record.method ?? record.reason ?? "(uncorrelated)",
    )}</td>
    <td><span class="tag ${record.kind}">${record.kind}</span></td>
    <td class="c-ms ${slow ? "slow" : ""}">${record.ms === undefined ? "" : `${record.ms}ms`}</td>
    <td class="c-bytes">${formatBytes(record.bytes)}${record.truncated ? " *" : ""}</td>`;

  tr.addEventListener("click", () => select(record));
  return tr;
}

function select(record) {
  state.selectedSeq = record.seq;

  for (const tr of ui.rows.children) {
    tr.classList.toggle("selected", tr.dataset.seq === String(record.seq));
  }

  ui.detailTitle.textContent = record.method ?? `${record.kind} record`;

  const meta = [
    ["Time", record.ts],
    ["Sequence", record.seq],
    ["Direction", record.dir === "to-server" ? "agent to server" : "server to agent"],
    ["Kind", record.kind],
    ["Id", record.id === undefined ? "none" : JSON.stringify(record.id)],
    ["Duration", record.ms === undefined ? "not correlated" : `${record.ms} ms`],
    ["Wire size", formatBytes(record.bytes)],
    ["Session", record.session],
  ];
  if (record.reason) meta.push(["Note", record.reason]);
  if (record.truncated) meta.push(["Payload", "truncated in the log, not on the wire"]);

  ui.detailMeta.innerHTML = meta
    .map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(String(v))}</dd>`)
    .join("");

  const payload = record.params ?? record.result ?? record.error ?? null;
  ui.detailBody.textContent =
    payload === null ? "No payload on this record." : JSON.stringify(payload, null, 2);

  ui.detail.hidden = false;
}

function showEmpty(message) {
  ui.rows.innerHTML = "";
  ui.empty.textContent = message;
  ui.empty.hidden = false;
}

function setLive(on) {
  ui.live.setAttribute("aria-pressed", String(on));

  if (state.stream) {
    state.stream.close();
    state.stream = null;
  }
  if (!on || !state.server) return;

  const stream = new EventSource(`/api/stream/${encodeURIComponent(state.server)}`);
  stream.onmessage = (event) => {
    let record;
    try {
      record = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!matchesFilters(record)) return;

    state.records.push(record);
    if (state.records.length > MAX_ROWS) state.records.shift();

    ui.empty.hidden = true;
    ui.rows.appendChild(rowFor(record));
    while (ui.rows.children.length > MAX_ROWS) ui.rows.removeChild(ui.rows.firstChild);
    ui.rows.lastChild.scrollIntoView({ block: "nearest" });
  };
  stream.onerror = () => setLive(false);
  state.stream = stream;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value).replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char],
  );
}

const escapeAttr = escapeHtml;

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

ui.server.addEventListener("change", () => {
  state.server = ui.server.value;
  state.selectedSeq = null;
  ui.detail.hidden = true;
  const wasLive = ui.live.getAttribute("aria-pressed") === "true";
  setLive(false);
  void load().then(() => setLive(wasLive));
});

ui.methods.addEventListener("click", (event) => {
  const button = event.target.closest(".method-row");
  if (!button) return;
  ui.q.value = ui.q.value === button.dataset.method ? "" : button.dataset.method;
  void load();
});

ui.refresh.addEventListener("click", () => void load());
ui.live.addEventListener("click", () =>
  setLive(ui.live.getAttribute("aria-pressed") !== "true"),
);
ui.detailClose.addEventListener("click", () => {
  ui.detail.hidden = true;
});

const reload = debounce(() => void load(), 200);
ui.q.addEventListener("input", reload);
ui.kind.addEventListener("change", reload);
ui.dir.addEventListener("change", reload);

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") ui.detail.hidden = true;
});

void loadServers().catch((error) => showEmpty(`Could not reach the dashboard API: ${error.message}`));
