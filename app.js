"use strict";

/**
 * Drive Duplicate Photo Cleaner
 * Pure client-side app: signs in with Google Identity Services, talks directly
 * to the Drive REST API from the browser, and never sends data anywhere else.
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const GOOGLE_CLIENT_ID = "432225616356-ib3amsha9j04d87kmolbg2j3vkjj2v6u.apps.googleusercontent.com";

const state = {
  accessToken: null,
  tokenClient: null,
  groups: [], // [{ checksum, files: [{id,name,size,createdTime,thumbnailLink,mimeType}], keepId }]
  selected: new Set(), // file ids marked for deletion
  thumbCache: new Map(), // fileId -> object URL
};

const el = (id) => document.getElementById(id);

const els = {
  signInBtn: el("signInBtn"),
  signOutBtn: el("signOutBtn"),
  scanCard: el("scanCard"),
  scanBtn: el("scanBtn"),
  ownedOnlyChk: el("ownedOnlyChk"),
  sharedDrivesChk: el("sharedDrivesChk"),
  scanProgress: el("scanProgress"),
  scanProgressFill: el("scanProgressFill"),
  scanProgressText: el("scanProgressText"),
  scanError: el("scanError"),
  resultsCard: el("resultsCard"),
  summaryGroups: el("summaryGroups"),
  summaryFiles: el("summaryFiles"),
  summarySize: el("summarySize"),
  selectDefaultBtn: el("selectDefaultBtn"),
  deselectAllBtn: el("deselectAllBtn"),
  trashSelectedBtn: el("trashSelectedBtn"),
  deleteProgress: el("deleteProgress"),
  deleteProgressFill: el("deleteProgressFill"),
  deleteProgressText: el("deleteProgressText"),
  groupsList: el("groupsList"),
  emptyCard: el("emptyCard"),
  confirmModal: el("confirmModal"),
  confirmText: el("confirmText"),
  confirmCancelBtn: el("confirmCancelBtn"),
  confirmDeleteBtn: el("confirmDeleteBtn"),
};

function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function updateSetupWarning() {
  els.scanCard.classList.toggle("hidden", !state.accessToken);
}

function initTokenClientIfNeeded() {
  if (!window.google || !google.accounts || state.tokenClient) return;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: DRIVE_SCOPE,
    callback: (resp) => {
      if (resp.error) {
        showScanError(`Sign-in failed: ${resp.error}`);
        return;
      }
      state.accessToken = resp.access_token;
      els.signInBtn.classList.add("hidden");
      els.signOutBtn.classList.remove("hidden");
      updateSetupWarning();
    },
  });
}

function signIn() {
  initTokenClientIfNeeded();
  if (!state.tokenClient) {
    showScanError("Google sign-in library hasn't loaded yet. Please try again in a moment.");
    return;
  }
  state.tokenClient.requestAccessToken({ prompt: state.accessToken ? "" : "consent" });
}

function signOut() {
  if (state.accessToken && window.google?.accounts?.oauth2) {
    google.accounts.oauth2.revoke(state.accessToken, () => {});
  }
  state.accessToken = null;
  els.signInBtn.classList.remove("hidden");
  els.signOutBtn.classList.add("hidden");
  els.resultsCard.classList.add("hidden");
  els.emptyCard.classList.add("hidden");
  updateSetupWarning();
}

function showScanError(message) {
  els.scanError.textContent = message;
  els.scanError.classList.toggle("hidden", !message);
}

async function driveFetch(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: {
      Authorization: `Bearer ${state.accessToken}`,
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = body?.error?.message || "";
    } catch (_) {
      /* ignore parse errors */
    }
    const err = new Error(`Drive API error ${res.status}${detail ? `: ${detail}` : ""}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function listAllImageFiles({ ownedOnly, sharedDrives, onProgress }) {
  const files = [];
  let pageToken = null;
  const fields =
    "nextPageToken, files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,thumbnailLink,parents,ownedByMe)";
  const qParts = ["mimeType contains 'image/'", "trashed = false"];
  if (ownedOnly) qParts.push("'me' in owners");
  const q = qParts.join(" and ");

  const MAX_FILES = 50000;
  do {
    const params = new URLSearchParams({
      q,
      fields,
      pageSize: "1000",
      spaces: "drive",
    });
    if (pageToken) params.set("pageToken", pageToken);
    if (sharedDrives) {
      params.set("includeItemsFromAllDrives", "true");
      params.set("supportsAllDrives", "true");
      params.set("corpora", "allDrives");
    }
    const data = await driveFetch(`${DRIVE_FILES_ENDPOINT}?${params.toString()}`);
    files.push(...(data.files || []));
    pageToken = data.nextPageToken || null;
    onProgress?.(files.length);
  } while (pageToken && files.length < MAX_FILES);

  return files;
}

function groupDuplicates(files) {
  const byChecksum = new Map();
  let skippedNoChecksum = 0;
  for (const f of files) {
    if (!f.md5Checksum) {
      skippedNoChecksum++;
      continue;
    }
    if (!byChecksum.has(f.md5Checksum)) byChecksum.set(f.md5Checksum, []);
    byChecksum.get(f.md5Checksum).push(f);
  }

  const groups = [];
  for (const [checksum, groupFiles] of byChecksum.entries()) {
    if (groupFiles.length < 2) continue;
    groupFiles.sort((a, b) => new Date(a.createdTime) - new Date(b.createdTime));
    groups.push({ checksum, files: groupFiles, keepId: groupFiles[0].id });
  }
  groups.sort((a, b) => b.files.length - a.files.length);
  return { groups, skippedNoChecksum };
}

async function scan() {
  showScanError("");
  els.resultsCard.classList.add("hidden");
  els.emptyCard.classList.add("hidden");
  els.scanBtn.disabled = true;
  els.scanProgress.classList.remove("hidden");
  els.scanProgressFill.style.width = "10%";
  els.scanProgressText.textContent = "Scanning your Drive for photos…";

  try {
    const files = await listAllImageFiles({
      ownedOnly: els.ownedOnlyChk.checked,
      sharedDrives: els.sharedDrivesChk.checked,
      onProgress: (count) => {
        els.scanProgressText.textContent = `Scanned ${count} photo${count === 1 ? "" : "s"}…`;
        els.scanProgressFill.style.width = "60%";
      },
    });

    els.scanProgressFill.style.width = "90%";
    const { groups, skippedNoChecksum } = groupDuplicates(files);
    state.groups = groups;
    state.selected = new Set();
    state.thumbCache.forEach((url) => URL.revokeObjectURL(url));
    state.thumbCache.clear();

    els.scanProgressFill.style.width = "100%";

    if (groups.length === 0) {
      els.emptyCard.classList.remove("hidden");
    } else {
      selectDefaultDuplicates();
      renderGroups();
      els.resultsCard.classList.remove("hidden");
    }

    if (skippedNoChecksum > 0) {
      showScanError(
        `Note: ${skippedNoChecksum} file(s) had no content checksum available and were skipped from duplicate detection.`
      );
    }
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      showScanError("Your session expired. Please sign in again.");
      state.accessToken = null;
      els.signInBtn.classList.remove("hidden");
      els.signOutBtn.classList.add("hidden");
      updateSetupWarning();
    } else if (err.status === 403) {
      showScanError(
        "Drive API access was denied (403). Make sure the Google Drive API is enabled for your Google Cloud project and that your account is added as a test user on the OAuth consent screen."
      );
    } else {
      showScanError(err.message || "Something went wrong while scanning.");
    }
  } finally {
    els.scanBtn.disabled = false;
    setTimeout(() => els.scanProgress.classList.add("hidden"), 400);
  }
}

function selectDefaultDuplicates() {
  state.selected.clear();
  for (const group of state.groups) {
    for (const f of group.files) {
      if (f.id !== group.keepId) state.selected.add(f.id);
    }
  }
}

function deselectAll() {
  state.selected.clear();
  renderGroups();
}

function totalSelectedSize() {
  let total = 0;
  for (const group of state.groups) {
    for (const f of group.files) {
      if (state.selected.has(f.id)) total += Number(f.size || 0);
    }
  }
  return total;
}

function updateSummary() {
  const totalExtraFiles = state.groups.reduce((sum, g) => sum + g.files.length - 1, 0);
  const totalReclaimable = state.groups.reduce((sum, g) => {
    return sum + g.files.filter((f) => f.id !== g.keepId).reduce((s, f) => s + Number(f.size || 0), 0);
  }, 0);
  els.summaryGroups.textContent = String(state.groups.length);
  els.summaryFiles.textContent = String(totalExtraFiles);
  els.summarySize.textContent = formatBytes(totalReclaimable);

  const count = state.selected.size;
  els.trashSelectedBtn.textContent = `Move ${count} file${count === 1 ? "" : "s"} to Trash`;
  els.trashSelectedBtn.disabled = count === 0;
}

async function loadThumb(file, imgEl) {
  if (!file.thumbnailLink) return;
  if (state.thumbCache.has(file.id)) {
    imgEl.src = state.thumbCache.get(file.id);
    return;
  }
  try {
    const res = await fetch(file.thumbnailLink, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    state.thumbCache.set(file.id, url);
    imgEl.src = url;
  } catch (_) {
    /* thumbnail is best-effort */
  }
}

function renderGroups() {
  els.groupsList.innerHTML = "";
  const thumbQueue = [];

  for (const group of state.groups) {
    const card = document.createElement("div");
    card.className = "group-card";

    const header = document.createElement("div");
    header.className = "group-card-header";
    header.innerHTML = `<span>${group.files.length} copies</span><span class="muted">${escapeHtml(
      group.files[0].name
    )}</span>`;
    card.appendChild(header);

    const filesWrap = document.createElement("div");
    filesWrap.className = "group-files";

    for (const f of group.files) {
      const isKept = f.id === group.keepId;
      const tile = document.createElement("div");
      tile.className = "file-tile" + (isKept ? " kept" : "");

      const img = document.createElement("img");
      img.className = "file-thumb";
      img.alt = f.name;
      img.src =
        "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";
      tile.appendChild(img);
      thumbQueue.push([f, img]);

      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = f.name;
      tile.appendChild(name);

      const meta = document.createElement("div");
      meta.className = "file-meta";
      const date = f.createdTime ? new Date(f.createdTime).toLocaleDateString() : "";
      meta.textContent = `${formatBytes(Number(f.size || 0))} · ${date}`;
      tile.appendChild(meta);

      const controls = document.createElement("div");
      controls.className = "file-controls";

      if (isKept) {
        const badge = document.createElement("span");
        badge.className = "keep-badge";
        badge.textContent = "Keeping";
        controls.appendChild(badge);
      } else {
        const label = document.createElement("label");
        label.className = "checkbox-inline";
        const cb = document.createElement("input");
        cb.type = "checkbox";
        cb.checked = state.selected.has(f.id);
        cb.addEventListener("change", () => {
          if (cb.checked) state.selected.add(f.id);
          else state.selected.delete(f.id);
          updateSummary();
        });
        label.appendChild(cb);
        label.appendChild(document.createTextNode(" delete"));
        controls.appendChild(label);
      }

      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "btn btn-ghost";
      keepBtn.style.fontSize = "0.65rem";
      keepBtn.style.padding = "2px 6px";
      keepBtn.textContent = isKept ? "" : "keep this";
      if (!isKept) {
        keepBtn.addEventListener("click", () => {
          group.keepId = f.id;
          state.selected.delete(f.id);
          for (const other of group.files) {
            if (other.id !== group.keepId) state.selected.add(other.id);
          }
          renderGroups();
        });
        controls.appendChild(keepBtn);
      }

      tile.appendChild(controls);
      filesWrap.appendChild(tile);
    }

    card.appendChild(filesWrap);
    els.groupsList.appendChild(card);
  }

  updateSummary();

  // Load thumbnails with limited concurrency so we don't fire hundreds of
  // requests at once.
  let idx = 0;
  const CONCURRENCY = 6;
  const worker = async () => {
    while (idx < thumbQueue.length) {
      const [f, imgEl] = thumbQueue[idx++];
      await loadThumb(f, imgEl);
    }
  };
  for (let i = 0; i < CONCURRENCY; i++) worker();
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function openConfirm() {
  const count = state.selected.size;
  const size = formatBytes(totalSelectedSize());
  els.confirmText.textContent = `This will move ${count} file${count === 1 ? "" : "s"} (${size}) to your Google Drive Trash.`;
  els.confirmModal.classList.remove("hidden");
}

function closeConfirm() {
  els.confirmModal.classList.add("hidden");
}

async function trashSelected() {
  closeConfirm();
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;

  els.trashSelectedBtn.disabled = true;
  els.deleteProgress.classList.remove("hidden");
  els.deleteProgressFill.style.width = "0%";

  let done = 0;
  let failed = 0;
  const CONCURRENCY = 5;
  let idx = 0;
  const succeededIds = new Set();

  const updateProgress = () => {
    const pct = Math.round(((done + failed) / ids.length) * 100);
    els.deleteProgressFill.style.width = `${pct}%`;
    els.deleteProgressText.textContent = `Trashed ${done}/${ids.length}${failed ? `, ${failed} failed` : ""}…`;
  };

  const worker = async () => {
    while (idx < ids.length) {
      const fileId = ids[idx++];
      try {
        await driveFetch(`${DRIVE_FILES_ENDPOINT}/${fileId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ trashed: true }),
        });
        done++;
        succeededIds.add(fileId);
      } catch (err) {
        console.error(`Failed to trash ${fileId}`, err);
        failed++;
      }
      updateProgress();
    }
  };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  els.deleteProgressText.textContent = `Done: ${done} file${done === 1 ? "" : "s"} moved to Trash${
    failed ? `, ${failed} failed` : ""
  }.`;

  // Drop successfully-trashed files from local state and re-render without a
  // full re-scan. Groups that no longer have duplicates are removed entirely.
  state.groups = state.groups
    .map((group) => ({
      ...group,
      files: group.files.filter((f) => !succeededIds.has(f.id)),
    }))
    .filter((group) => group.files.length > 1);
  state.selected = new Set(Array.from(state.selected).filter((id) => !succeededIds.has(id)));

  setTimeout(() => {
    els.deleteProgress.classList.add("hidden");
    if (state.groups.length === 0) {
      els.resultsCard.classList.add("hidden");
      els.emptyCard.classList.remove("hidden");
    } else {
      renderGroups();
    }
  }, 800);

  els.trashSelectedBtn.disabled = false;
}

// Wire up events.
els.signInBtn.addEventListener("click", signIn);
els.signOutBtn.addEventListener("click", signOut);
els.scanBtn.addEventListener("click", scan);
els.selectDefaultBtn.addEventListener("click", () => {
  selectDefaultDuplicates();
  renderGroups();
});
els.deselectAllBtn.addEventListener("click", deselectAll);
els.trashSelectedBtn.addEventListener("click", openConfirm);
els.confirmCancelBtn.addEventListener("click", closeConfirm);
els.confirmDeleteBtn.addEventListener("click", trashSelected);

window.addEventListener("load", () => {
  updateSetupWarning();
  initTokenClientIfNeeded();
});
