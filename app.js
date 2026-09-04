"use strict";

/**
 * Drive Duplicate File Cleaner
 * Pure client-side app: signs in with Google Identity Services, talks directly
 * to the Drive REST API from the browser, and never sends data anywhere else.
 */

const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive";
const DRIVE_FILES_ENDPOINT = "https://www.googleapis.com/drive/v3/files";
const STORAGE_KEY_CLIENT_ID = "ddpc.clientId";
const DEFAULT_CLIENT_ID = "432225616356-3ub4t7ifjb3akgut0lepiioj208rif06.apps.googleusercontent.com";

const CATEGORIES = ["photos", "videos", "pdfs", "docs", "others"];
const CATEGORY_LABELS = {
  all: "All files",
  photos: "Photos",
  videos: "Videos",
  pdfs: "PDFs",
  docs: "Docs",
  others: "Others",
};

function categoryOf(mimeType) {
  if (!mimeType) return "others";
  if (mimeType.startsWith("image/")) return "photos";
  if (mimeType.startsWith("video/")) return "videos";
  if (mimeType === "application/pdf") return "pdfs";
  if (
    mimeType.startsWith("application/vnd.google-apps.document") ||
    mimeType.startsWith("application/vnd.google-apps.spreadsheet") ||
    mimeType.startsWith("application/vnd.google-apps.presentation") ||
    mimeType.startsWith("application/msword") ||
    mimeType.startsWith("application/vnd.openxmlformats-officedocument") ||
    mimeType === "text/plain" ||
    mimeType === "application/rtf"
  ) {
    return "docs";
  }
  return "others";
}

const state = {
  clientId: localStorage.getItem(STORAGE_KEY_CLIENT_ID) || DEFAULT_CLIENT_ID,
  accessToken: null,
  tokenClient: null,
  groups: [], // [{ checksum, category, files: [{id,name,size,createdTime,thumbnailLink,mimeType,path}], keepId }]
  selected: new Set(), // file ids marked for deletion
  activeCategory: "all",
  folderNameCache: new Map(), // folder id -> name
};

const el = (id) => document.getElementById(id);

const els = {
  settingsBtn: el("settingsBtn"),
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
  categoryTabs: el("categoryTabs"),
  summaryGroups: el("summaryGroups"),
  summaryFiles: el("summaryFiles"),
  summarySize: el("summarySize"),
  keepRuleSelect: el("keepRuleSelect"),
  applyKeepRuleBtn: el("applyKeepRuleBtn"),
  deselectAllBtn: el("deselectAllBtn"),
  trashSelectedBtn: el("trashSelectedBtn"),
  deleteProgress: el("deleteProgress"),
  deleteProgressFill: el("deleteProgressFill"),
  deleteProgressText: el("deleteProgressText"),
  groupsList: el("groupsList"),
  emptyCard: el("emptyCard"),
  settingsModal: el("settingsModal"),
  clientIdInput: el("clientIdInput"),
  settingsCancelBtn: el("settingsCancelBtn"),
  settingsSaveBtn: el("settingsSaveBtn"),
  confirmModal: el("confirmModal"),
  confirmText: el("confirmText"),
  confirmCancelBtn: el("confirmCancelBtn"),
  confirmDeleteBtn: el("confirmDeleteBtn"),
};

let pendingDeleteIds = null; // set by openConfirm; null means "use state.selected"

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

function openSettings() {
  els.clientIdInput.value = state.clientId;
  els.settingsModal.classList.remove("hidden");
}

function closeSettings() {
  els.settingsModal.classList.add("hidden");
}

function saveSettings() {
  const newClientId = els.clientIdInput.value.trim() || DEFAULT_CLIENT_ID;
  if (newClientId !== state.clientId) {
    state.clientId = newClientId;
    localStorage.setItem(STORAGE_KEY_CLIENT_ID, state.clientId);
    state.tokenClient = null;
    state.accessToken = null;
    els.signInBtn.classList.remove("hidden");
    els.signOutBtn.classList.add("hidden");
    updateSetupWarning();
  }
  closeSettings();
  initTokenClientIfNeeded();
}

function initTokenClientIfNeeded() {
  if (!window.google || !google.accounts || state.tokenClient) return;
  state.tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: state.clientId,
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

async function listAllFiles({ ownedOnly, sharedDrives, onProgress }) {
  const files = [];
  let pageToken = null;
  const fields =
    "nextPageToken, files(id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,thumbnailLink,parents,ownedByMe)";
  const qParts = ["trashed = false"];
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

async function getFolderName(folderId) {
  if (folderId === "root") return "My Drive";
  if (state.folderNameCache.has(folderId)) return state.folderNameCache.get(folderId);
  let data = null;
  try {
    data = await driveFetch(`${DRIVE_FILES_ENDPOINT}/${folderId}?fields=id,name,parents&supportsAllDrives=true`);
  } catch (_) {
    /* leave data as null; still cache below so we don't retry a known failure */
  }
  state.folderNameCache.set(folderId, data);
  return data;
}

async function resolvePath(parents) {
  if (!parents || parents.length === 0) return "My Drive";
  const parts = [];
  let currentId = parents[0];
  let hops = 0;
  while (currentId && hops < 20) {
    hops++;
    if (currentId === "root") {
      parts.unshift("My Drive");
      break;
    }
    const folder = await getFolderName(currentId);
    if (!folder || !folder.name) break;
    parts.unshift(folder.name);
    currentId = folder.parents?.[0];
  }
  if (parts.length === 0 || parts[0] !== "My Drive") parts.unshift("My Drive");
  return parts.join(" / ");
}

async function attachPaths(files, onProgress) {
  let done = 0;
  const CONCURRENCY = 8;
  let idx = 0;
  const worker = async () => {
    while (idx < files.length) {
      const f = files[idx++];
      f.path = await resolvePath(f.parents);
      done++;
      if (done % 25 === 0) onProgress?.(done, files.length);
    }
  };
  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);
  onProgress?.(files.length, files.length);
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
    groups.push({
      checksum,
      category: categoryOf(groupFiles[0].mimeType),
      files: groupFiles,
      keepId: groupFiles[0].id,
    });
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
  els.scanProgressText.textContent = "Scanning your Drive…";

  try {
    const files = await listAllFiles({
      ownedOnly: els.ownedOnlyChk.checked,
      sharedDrives: els.sharedDrivesChk.checked,
      onProgress: (count) => {
        els.scanProgressText.textContent = `Scanned ${count} file${count === 1 ? "" : "s"}…`;
        els.scanProgressFill.style.width = "50%";
      },
    });

    els.scanProgressFill.style.width = "60%";
    const { groups, skippedNoChecksum } = groupDuplicates(files);

    const dupFiles = groups.flatMap((g) => g.files);
    if (dupFiles.length > 0) {
      els.scanProgressText.textContent = `Resolving folder paths for ${dupFiles.length} duplicate file(s)…`;
      await attachPaths(dupFiles, (done, total) => {
        els.scanProgressText.textContent = `Resolving folder paths… ${done}/${total}`;
        els.scanProgressFill.style.width = `${60 + Math.round((done / total) * 30)}%`;
      });
    }

    state.groups = groups;
    state.selected = new Set();
    state.activeCategory = "all";

    els.scanProgressFill.style.width = "100%";

    if (groups.length === 0) {
      els.emptyCard.classList.remove("hidden");
    } else {
      selectDefaultDuplicates("oldest");
      renderCategoryTabs();
      renderGroups();
      els.resultsCard.classList.remove("hidden");
    }

    if (skippedNoChecksum > 0) {
      showScanError(
        `Note: ${skippedNoChecksum} file(s) had no content checksum available (e.g. native Google Docs/Sheets/Slides) and were skipped from duplicate detection.`
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

function selectDefaultDuplicates(rule) {
  state.selected.clear();
  for (const group of state.groups) {
    // files within a group are already sorted oldest -> newest
    group.keepId = rule === "newest" ? group.files[group.files.length - 1].id : group.files[0].id;
    for (const f of group.files) {
      if (f.id !== group.keepId) state.selected.add(f.id);
    }
  }
}

function visibleGroups() {
  if (state.activeCategory === "all") return state.groups;
  return state.groups.filter((g) => g.category === state.activeCategory);
}

function renderCategoryTabs() {
  const counts = { all: state.groups.length };
  for (const cat of CATEGORIES) counts[cat] = 0;
  for (const g of state.groups) counts[g.category] = (counts[g.category] || 0) + 1;

  els.categoryTabs.innerHTML = "";
  const tabs = ["all", ...CATEGORIES];
  for (const cat of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "category-tab" + (state.activeCategory === cat ? " active" : "");
    btn.textContent = `${CATEGORY_LABELS[cat]} (${counts[cat] || 0})`;
    btn.addEventListener("click", () => {
      state.activeCategory = cat;
      renderCategoryTabs();
      renderGroups();
    });
    els.categoryTabs.appendChild(btn);
  }
}

function deselectAll() {
  // Only clear selection within the currently visible category so switching
  // tabs doesn't silently wipe selections made elsewhere.
  const visibleIds = new Set(visibleGroups().flatMap((g) => g.files.map((f) => f.id)));
  state.selected = new Set(Array.from(state.selected).filter((id) => !visibleIds.has(id)));
  renderGroups();
}

function totalSelectedSize() {
  return totalSizeForIds(state.selected);
}

function totalSizeForIds(ids) {
  const idSet = ids instanceof Set ? ids : new Set(ids);
  let total = 0;
  for (const group of state.groups) {
    for (const f of group.files) {
      if (idSet.has(f.id)) total += Number(f.size || 0);
    }
  }
  return total;
}

function updateSummary() {
  const groups = visibleGroups();
  const totalExtraFiles = groups.reduce((sum, g) => sum + g.files.length - 1, 0);
  const totalReclaimable = groups.reduce((sum, g) => {
    return sum + g.files.filter((f) => f.id !== g.keepId).reduce((s, f) => s + Number(f.size || 0), 0);
  }, 0);
  els.summaryGroups.textContent = String(groups.length);
  els.summaryFiles.textContent = String(totalExtraFiles);
  els.summarySize.textContent = formatBytes(totalReclaimable);

  const visibleIds = new Set(groups.flatMap((g) => g.files.map((f) => f.id)));
  const count = Array.from(state.selected).filter((id) => visibleIds.has(id)).length;
  els.trashSelectedBtn.textContent = `Move ${count} file${count === 1 ? "" : "s"} to Trash`;
  els.trashSelectedBtn.disabled = count === 0;
}

function loadThumb(file, imgEl) {
  if (!file.thumbnailLink) return;
  // thumbnailLink is served from lh3.googleusercontent.com without CORS
  // headers, so it can't be fetch()'d with an Authorization header. Loading
  // it directly as an <img> avoids the CORS preflight and works using the
  // signed URL Drive already returned.
  imgEl.src = file.thumbnailLink;
}

const CATEGORY_ICONS = {
  photos: "🖼️",
  videos: "🎬",
  pdfs: "📄",
  docs: "📝",
  others: "📦",
};

function deleteSingleFile(fileId) {
  pendingDeleteIds = [fileId];
  const size = formatBytes(totalSizeForIds(pendingDeleteIds));
  els.confirmText.textContent = `This will move 1 file (${size}) to your Google Drive Trash.`;
  els.confirmModal.classList.remove("hidden");
}

function renderGroups() {
  els.groupsList.innerHTML = "";
  const thumbQueue = [];
  const groups = visibleGroups();

  for (const group of groups) {
    const card = document.createElement("div");
    card.className = "group-card";

    const header = document.createElement("div");
    header.className = "group-card-header";
    header.innerHTML = `<span>${CATEGORY_ICONS[group.category] || ""} ${group.files.length} copies</span><span class="muted">${escapeHtml(
      group.files[0].name
    )}</span>`;
    card.appendChild(header);

    const filesWrap = document.createElement("div");
    filesWrap.className = "group-files";

    for (const f of group.files) {
      const isKept = f.id === group.keepId;
      const tile = document.createElement("div");
      tile.className = "file-tile" + (isKept ? " kept" : "");

      if (group.category === "photos" && f.thumbnailLink) {
        const img = document.createElement("img");
        img.className = "file-thumb";
        img.alt = f.name;
        img.src =
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";
        tile.appendChild(img);
        thumbQueue.push([f, img]);
      } else {
        const placeholder = document.createElement("div");
        placeholder.className = "file-thumb-placeholder";
        placeholder.textContent = CATEGORY_ICONS[group.category] || "📦";
        tile.appendChild(placeholder);
      }

      const name = document.createElement("div");
      name.className = "file-name";
      name.textContent = f.name;
      tile.appendChild(name);

      const path = document.createElement("div");
      path.className = "file-path";
      path.textContent = f.path || "";
      path.title = f.path || "";
      tile.appendChild(path);

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

      const btnRow = document.createElement("div");
      btnRow.className = "file-btn-row";

      const keepBtn = document.createElement("button");
      keepBtn.type = "button";
      keepBtn.className = "btn btn-ghost btn-tiny";
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
        btnRow.appendChild(keepBtn);
      }

      if (!isKept) {
        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "btn btn-danger btn-tiny";
        deleteBtn.textContent = "delete now";
        deleteBtn.addEventListener("click", () => deleteSingleFile(f.id));
        btnRow.appendChild(deleteBtn);
      }

      controls.appendChild(btnRow);
      tile.appendChild(controls);
      filesWrap.appendChild(tile);
    }

    card.appendChild(filesWrap);
    els.groupsList.appendChild(card);
  }

  updateSummary();

  for (const [f, imgEl] of thumbQueue) loadThumb(f, imgEl);
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

function openConfirm() {
  pendingDeleteIds = null;
  const visibleIds = new Set(visibleGroups().flatMap((g) => g.files.map((f) => f.id)));
  const idsToDelete = Array.from(state.selected).filter((id) => visibleIds.has(id));
  const count = idsToDelete.length;
  const size = formatBytes(totalSizeForIds(idsToDelete));
  els.confirmText.textContent = `This will move ${count} file${count === 1 ? "" : "s"} (${size}) to your Google Drive Trash.`;
  els.confirmModal.classList.remove("hidden");
}

function closeConfirm() {
  pendingDeleteIds = null;
  els.confirmModal.classList.add("hidden");
}

async function trashSelected() {
  const visibleIds = new Set(visibleGroups().flatMap((g) => g.files.map((f) => f.id)));
  const ids = pendingDeleteIds || Array.from(state.selected).filter((id) => visibleIds.has(id));
  closeConfirm();
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
      renderCategoryTabs();
      renderGroups();
    }
  }, 800);

  els.trashSelectedBtn.disabled = false;
}

// Wire up events.
els.settingsBtn.addEventListener("click", openSettings);
els.settingsCancelBtn.addEventListener("click", closeSettings);
els.settingsSaveBtn.addEventListener("click", saveSettings);
els.signInBtn.addEventListener("click", signIn);
els.signOutBtn.addEventListener("click", signOut);
els.scanBtn.addEventListener("click", scan);
els.applyKeepRuleBtn.addEventListener("click", () => {
  selectDefaultDuplicates(els.keepRuleSelect.value);
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
