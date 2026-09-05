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
  activeView: "duplicates", // "duplicates" | "timeline"
  timelineItems: [], // ALL photo/video files, sorted newest-first by true capture time
  timelineRenderedCount: 0, // how many of timelineItems have been appended to the DOM so far
  timelineLoading: false,
  lightboxIndex: -1, // index into timelineItems currently shown in the lightbox
  timelineSelected: new Set(), // file ids selected in the Timeline grid
};

const el = (id) => document.getElementById(id);

const els = {
  settingsBtn: el("settingsBtn"),
  signInBtn: el("signInBtn"),
  signOutBtn: el("signOutBtn"),
  viewTabs: el("viewTabs"),
  viewTabDuplicates: el("viewTabDuplicates"),
  viewTabTimeline: el("viewTabTimeline"),
  duplicatesView: el("duplicatesView"),
  timelineView: el("timelineView"),
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
  timelineScanCard: el("timelineScanCard"),
  timelineScanBtn: el("timelineScanBtn"),
  timelineOwnedOnlyChk: el("timelineOwnedOnlyChk"),
  timelineScanProgress: el("timelineScanProgress"),
  timelineScanProgressFill: el("timelineScanProgressFill"),
  timelineScanProgressText: el("timelineScanProgressText"),
  timelineScanError: el("timelineScanError"),
  timelineEmptyCard: el("timelineEmptyCard"),
  timelineSections: el("timelineSections"),
  timelineSentinel: el("timelineSentinel"),
  timelineToolbar: el("timelineToolbar"),
  timelineSelectedCount: el("timelineSelectedCount"),
  timelineDownloadSelectedBtn: el("timelineDownloadSelectedBtn"),
  timelineDeleteSelectedBtn: el("timelineDeleteSelectedBtn"),
  timelineClearSelectionBtn: el("timelineClearSelectionBtn"),
  lightbox: el("lightbox"),
  lightboxCloseBtn: el("lightboxCloseBtn"),
  lightboxPrevBtn: el("lightboxPrevBtn"),
  lightboxNextBtn: el("lightboxNextBtn"),
  lightboxMedia: el("lightboxMedia"),
  lightboxName: el("lightboxName"),
  lightboxMeta: el("lightboxMeta"),
  lightboxPath: el("lightboxPath"),
  lightboxDownloadBtn: el("lightboxDownloadBtn"),
  lightboxDeleteBtn: el("lightboxDeleteBtn"),
};

let pendingDeleteIds = null; // set by openConfirm; null means "use state.selected"
let pendingDeleteSource = "duplicates"; // "duplicates" | "duplicates-single" | "timeline"

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
  els.timelineScanCard.classList.toggle("hidden", !state.accessToken);
  els.viewTabs.classList.toggle("hidden", !state.accessToken);
}

function switchView(view) {
  state.activeView = view;
  els.viewTabDuplicates.classList.toggle("active", view === "duplicates");
  els.viewTabTimeline.classList.toggle("active", view === "timeline");
  els.duplicatesView.classList.toggle("hidden", view !== "duplicates");
  els.timelineView.classList.toggle("hidden", view !== "timeline");
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
  closeLightbox();
  state.accessToken = null;
  state.timelineItems = [];
  state.timelineRenderedCount = 0;
  state.timelineSelected.clear();
  els.signInBtn.classList.remove("hidden");
  els.signOutBtn.classList.add("hidden");
  els.resultsCard.classList.add("hidden");
  els.emptyCard.classList.add("hidden");
  els.timelineSections.innerHTML = "";
  els.timelineEmptyCard.classList.add("hidden");
  updateTimelineToolbar();
  switchView("duplicates");
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

const FILE_FIELDS =
  "id,name,mimeType,size,md5Checksum,createdTime,modifiedTime,thumbnailLink,parents,ownedByMe," +
  "imageMediaMetadata,videoMediaMetadata";

// Prefer the EXIF/media capture time (when the file itself was actually
// photographed/recorded) over Drive's createdTime (when it was uploaded) —
// these often differ for photos imported after the fact. Falls back to
// createdTime when no capture time is present (screenshots, downloads,
// files missing EXIF, etc).
function captureTime(file) {
  const raw = file.imageMediaMetadata?.time || file.videoMediaMetadata?.time || file.createdTime;
  if (!raw) return null;
  // imageMediaMetadata.time is "YYYY:MM:DD HH:MM:SS" (EXIF format, no
  // timezone) rather than ISO 8601, so normalize it before parsing.
  const normalized = /^\d{4}:\d{2}:\d{2}/.test(raw) ? raw.replace(/^(\d{4}):(\d{2}):(\d{2})/, "$1-$2-$3") : raw;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date;
}

function buildFilesQuery({ ownedOnly, extraQuery }) {
  const qParts = ["trashed = false"];
  if (ownedOnly) qParts.push("'me' in owners");
  if (extraQuery) qParts.push(extraQuery);
  return qParts.join(" and ");
}

async function fetchFilesPage({ q, pageToken, pageSize, sharedDrives, orderBy }) {
  const params = new URLSearchParams({
    q,
    fields: `nextPageToken, files(${FILE_FIELDS})`,
    pageSize: String(pageSize || 1000),
    spaces: "drive",
  });
  if (pageToken) params.set("pageToken", pageToken);
  if (orderBy) params.set("orderBy", orderBy);
  if (sharedDrives) {
    params.set("includeItemsFromAllDrives", "true");
    params.set("supportsAllDrives", "true");
    params.set("corpora", "allDrives");
  }
  return driveFetch(`${DRIVE_FILES_ENDPOINT}?${params.toString()}`);
}

async function listAllFiles({ ownedOnly, sharedDrives, onProgress, extraQuery }) {
  const files = [];
  let pageToken = null;
  const q = buildFilesQuery({ ownedOnly, extraQuery });

  const MAX_FILES = 50000;
  do {
    const data = await fetchFilesPage({ q, pageToken, pageSize: 1000, sharedDrives });
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

function showTimelineError(message) {
  els.timelineScanError.textContent = message;
  els.timelineScanError.classList.toggle("hidden", !message);
}

const TIMELINE_FETCH_PAGE_SIZE = 1000; // Drive's max per request while fetching everything
const TIMELINE_RENDER_BATCH_SIZE = 100; // tiles revealed per scroll/render step

async function scanTimeline() {
  showTimelineError("");
  els.timelineEmptyCard.classList.add("hidden");
  els.timelineSections.innerHTML = "";
  state.timelineItems = [];
  state.timelineRenderedCount = 0;
  state.timelineSelected.clear();
  updateTimelineToolbar();
  els.timelineScanBtn.disabled = true;
  els.timelineScanProgress.classList.remove("hidden");
  els.timelineScanProgressFill.style.width = "5%";
  els.timelineScanProgressText.textContent = "Loading photos & videos…";

  const q = buildFilesQuery({
    ownedOnly: els.timelineOwnedOnlyChk.checked,
    extraQuery: "(mimeType contains 'image/' or mimeType contains 'video/')",
  });

  try {
    const all = [];
    let pageToken = null;
    const MAX_FILES = 50000;
    do {
      const data = await fetchFilesPage({
        q,
        pageToken,
        pageSize: TIMELINE_FETCH_PAGE_SIZE,
        sharedDrives: false,
        orderBy: "createdTime desc",
      });
      all.push(...(data.files || []));
      pageToken = data.nextPageToken || null;
      els.timelineScanProgressText.textContent = `Loaded ${all.length} item${all.length === 1 ? "" : "s"}…`;
      els.timelineScanProgressFill.style.width = `${Math.min(90, 10 + all.length / 50)}%`;
    } while (pageToken && all.length < MAX_FILES);

    for (const f of all) f.category = categoryOf(f.mimeType);
    all.sort((a, b) => (captureTime(b) || 0) - (captureTime(a) || 0));
    state.timelineItems = all;

    els.timelineScanProgressFill.style.width = "100%";

    if (all.length === 0) {
      els.timelineEmptyCard.classList.remove("hidden");
    } else {
      renderMoreTimeline();
    }
  } catch (err) {
    console.error(err);
    if (err.status === 401) {
      showTimelineError("Your session expired. Please sign in again.");
      state.accessToken = null;
      els.signInBtn.classList.remove("hidden");
      els.signOutBtn.classList.add("hidden");
      updateSetupWarning();
    } else {
      showTimelineError(err.message || "Something went wrong while loading the timeline.");
    }
  } finally {
    els.timelineScanBtn.disabled = false;
    setTimeout(() => els.timelineScanProgress.classList.add("hidden"), 400);
  }
}

// Reveals the next batch of already-fetched, already-sorted timeline items.
// Nothing here talks to Drive — it's purely appending DOM for items we
// already have in memory, keeping scroll responsive without re-fetching.
function renderMoreTimeline() {
  if (state.timelineLoading) return;
  if (state.timelineRenderedCount >= state.timelineItems.length) return;
  state.timelineLoading = true;

  const start = state.timelineRenderedCount;
  const end = Math.min(start + TIMELINE_RENDER_BATCH_SIZE, state.timelineItems.length);
  appendTimelineItems(state.timelineItems.slice(start, end));
  state.timelineRenderedCount = end;

  state.timelineLoading = false;
}

function timelineSectionLabel(date) {
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfDay = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  const dayDiff = Math.round((startOfToday - startOfDay) / 86400000);

  if (dayDiff === 0) return "Today";
  if (dayDiff === 1) return "Yesterday";
  if (date.getFullYear() === now.getFullYear()) {
    return date.toLocaleDateString(undefined, { month: "long", day: "numeric" });
  }
  return date.toLocaleDateString(undefined, { month: "long", year: "numeric" });
}

function buildTimelineTile(f) {
  const tile = document.createElement("div");
  tile.className = "timeline-tile";
  tile.dataset.fileId = f.id;
  tile.addEventListener("click", () => openLightbox(f.id));

  if (f.thumbnailLink) {
    const img = document.createElement("img");
    img.alt = f.name;
    img.src = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3C/svg%3E";
    tile.appendChild(img);
    loadThumb(f, img);
  } else {
    const placeholder = document.createElement("div");
    placeholder.className = "file-thumb-placeholder";
    placeholder.textContent = CATEGORY_ICONS[f.category] || "📦";
    tile.appendChild(placeholder);
  }

  if (f.category === "videos") {
    const badge = document.createElement("span");
    badge.className = "timeline-video-badge";
    badge.textContent = "▶";
    tile.appendChild(badge);
  }

  const checkLabel = document.createElement("label");
  checkLabel.className = "timeline-select";
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = state.timelineSelected.has(f.id);
  cb.addEventListener("click", (e) => {
    e.stopPropagation(); // don't open the lightbox
    if (cb.checked) state.timelineSelected.add(f.id);
    else state.timelineSelected.delete(f.id);
    tile.classList.toggle("selected", cb.checked);
    updateTimelineToolbar();
  });
  checkLabel.appendChild(cb);
  checkLabel.addEventListener("click", (e) => e.stopPropagation());
  tile.appendChild(checkLabel);

  if (state.timelineSelected.has(f.id)) tile.classList.add("selected");

  return tile;
}

// Appends a batch of files (already globally sorted by capture time) to the
// existing DOM instead of rebuilding it, so scrolling further doesn't
// re-render — or re-request thumbnails for — everything shown so far.
function appendTimelineItems(files) {
  let lastLabel = els.timelineSections.lastElementChild?.dataset.label || null;
  let lastGrid = els.timelineSections.lastElementChild?.querySelector(".timeline-grid") || null;

  for (const f of files) {
    const date = captureTime(f);
    const label = date ? timelineSectionLabel(date) : "Unknown date";

    if (label !== lastLabel) {
      const wrap = document.createElement("div");
      wrap.className = "timeline-section";
      wrap.dataset.label = label;

      const header = document.createElement("div");
      header.className = "timeline-section-header";
      header.textContent = label;
      wrap.appendChild(header);

      lastGrid = document.createElement("div");
      lastGrid.className = "timeline-grid";
      wrap.appendChild(lastGrid);

      els.timelineSections.appendChild(wrap);
      lastLabel = label;
    }

    lastGrid.appendChild(buildTimelineTile(f));
  }
}

function openLightbox(fileId) {
  const index = state.timelineItems.findIndex((f) => f.id === fileId);
  if (index === -1) return;
  state.lightboxIndex = index;
  renderLightbox();
  els.lightbox.classList.remove("hidden");
}

async function ensurePath(file) {
  if (file.path) return;
  file.path = await resolvePath(file.parents);
  // Only refresh the label if we're still looking at this same file.
  if (state.timelineItems[state.lightboxIndex] === file) {
    els.lightboxPath.textContent = file.path || "";
  }
}

let lightboxVideoUrl = null;

function closeLightbox() {
  els.lightbox.classList.add("hidden");
  els.lightboxMedia.innerHTML = "";
  if (lightboxVideoUrl) {
    URL.revokeObjectURL(lightboxVideoUrl);
    lightboxVideoUrl = null;
  }
  state.lightboxIndex = -1;
}

function navigateLightbox(delta) {
  if (state.lightboxIndex === -1) return;
  const next = state.lightboxIndex + delta;
  if (next < 0 || next >= state.timelineItems.length) return;
  // Make sure the grid has rendered up through this item so it's already
  // in the DOM (with a loaded thumbnail) by the time the user closes the
  // lightbox and scrolls back to it.
  while (state.timelineRenderedCount <= next) renderMoreTimeline();
  state.lightboxIndex = next;
  renderLightbox();
}

async function loadLightboxVideo(file, videoEl) {
  try {
    const res = await fetch(`${DRIVE_FILES_ENDPOINT}/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    if (!res.ok) return;
    const blob = await res.blob();
    // Only apply if the lightbox is still showing this same file.
    if (state.timelineItems[state.lightboxIndex] !== file) return;
    if (lightboxVideoUrl) URL.revokeObjectURL(lightboxVideoUrl);
    lightboxVideoUrl = URL.createObjectURL(blob);
    videoEl.src = lightboxVideoUrl;
  } catch (_) {
    /* best-effort */
  }
}

// Downloads the file's original bytes (full quality/resolution, not the
// resized thumbnailLink preview) by fetching Drive's alt=media endpoint
// with the OAuth header, then handing the browser a blob: URL to save.
async function downloadFile(file) {
  try {
    const res = await fetch(`${DRIVE_FILES_ENDPOINT}/${file.id}?alt=media`, {
      headers: { Authorization: `Bearer ${state.accessToken}` },
    });
    if (!res.ok) throw new Error(`Download failed (${res.status})`);
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  } catch (err) {
    console.error(`Failed to download ${file.id}`, err);
    showTimelineError(`Failed to download "${file.name}": ${err.message}`);
  }
}

async function downloadFiles(files) {
  for (const f of files) {
    await downloadFile(f);
  }
}

function renderLightbox() {
  const f = state.timelineItems[state.lightboxIndex];
  if (!f) return;

  els.lightboxMedia.innerHTML = "";
  if (lightboxVideoUrl) {
    URL.revokeObjectURL(lightboxVideoUrl);
    lightboxVideoUrl = null;
  }
  if (f.category === "videos") {
    const video = document.createElement("video");
    video.controls = true;
    video.autoplay = false;
    els.lightboxMedia.appendChild(video);
    loadLightboxVideo(f, video);
  } else {
    const img = document.createElement("img");
    img.alt = f.name;
    img.src = f.thumbnailLink ? f.thumbnailLink.replace(/=s\d+$/, "=s1600") : "";
    els.lightboxMedia.appendChild(img);
  }

  els.lightboxName.textContent = f.name;
  const date = captureTime(f)?.toLocaleString() || "";
  els.lightboxMeta.textContent = `${formatBytes(Number(f.size || 0))} · ${date}`;
  els.lightboxPath.textContent = f.path || "Loading path…";
  ensurePath(f);

  els.lightboxPrevBtn.disabled = state.lightboxIndex <= 0;
  els.lightboxNextBtn.disabled = state.lightboxIndex >= state.timelineItems.length - 1;
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
  pendingDeleteSource = "duplicates-single";
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
  pendingDeleteSource = "duplicates";
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

// Shared Drive-trash loop used by both the Duplicates tab and the Timeline
// tab. Returns the set of file ids that were successfully trashed.
async function trashFileIds(ids, onProgress) {
  let done = 0;
  let failed = 0;
  const CONCURRENCY = 5;
  let idx = 0;
  const succeededIds = new Set();

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
      onProgress?.(done, failed, ids.length);
    }
  };

  const workers = [];
  for (let i = 0; i < CONCURRENCY; i++) workers.push(worker());
  await Promise.all(workers);

  return { succeededIds, done, failed };
}

async function trashSelected() {
  const source = pendingDeleteSource;
  const visibleIds = new Set(visibleGroups().flatMap((g) => g.files.map((f) => f.id)));
  const ids = pendingDeleteIds || Array.from(state.selected).filter((id) => visibleIds.has(id));
  closeConfirm();
  if (ids.length === 0) return;

  if (source === "timeline") return trashTimelineFiles(ids);

  els.trashSelectedBtn.disabled = true;
  els.deleteProgress.classList.remove("hidden");
  els.deleteProgressFill.style.width = "0%";

  const { succeededIds, done, failed } = await trashFileIds(ids, (done, failed, total) => {
    const pct = Math.round(((done + failed) / total) * 100);
    els.deleteProgressFill.style.width = `${pct}%`;
    els.deleteProgressText.textContent = `Trashed ${done}/${total}${failed ? `, ${failed} failed` : ""}…`;
  });

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

async function trashTimelineFiles(ids) {
  showTimelineError("");
  const lightboxFile = state.timelineItems[state.lightboxIndex];
  const { succeededIds, failed } = await trashFileIds(ids);

  if (failed > 0) {
    showTimelineError(`${failed} file${failed === 1 ? "" : "s"} failed to move to Trash.`);
  }

  state.timelineItems = state.timelineItems.filter((f) => !succeededIds.has(f.id));
  for (const id of succeededIds) state.timelineSelected.delete(id);
  for (const id of succeededIds) {
    els.timelineSections.querySelector(`.timeline-tile[data-file-id="${id}"]`)?.remove();
  }
  // Remove any date sections that are now empty.
  for (const section of Array.from(els.timelineSections.children)) {
    if (section.querySelector(".timeline-grid")?.children.length === 0) section.remove();
  }
  state.timelineRenderedCount = Math.max(0, state.timelineRenderedCount - succeededIds.size);

  if (lightboxFile && succeededIds.has(lightboxFile.id)) closeLightbox();

  if (state.timelineItems.length === 0) {
    els.timelineEmptyCard.classList.remove("hidden");
  }
  updateTimelineToolbar();
}

function openTimelineDeleteConfirm(ids) {
  if (ids.length === 0) return;
  pendingDeleteIds = ids;
  pendingDeleteSource = "timeline";
  const idSet = new Set(ids);
  const size = formatBytes(
    state.timelineItems.filter((f) => idSet.has(f.id)).reduce((s, f) => s + Number(f.size || 0), 0)
  );
  els.confirmText.textContent = `This will move ${ids.length} file${ids.length === 1 ? "" : "s"} (${size}) to your Google Drive Trash.`;
  els.confirmModal.classList.remove("hidden");
}

function updateTimelineToolbar() {
  const count = state.timelineSelected.size;
  els.timelineToolbar.classList.toggle("hidden", count === 0);
  els.timelineSelectedCount.textContent = `${count} selected`;
}

function clearTimelineSelection() {
  for (const id of state.timelineSelected) {
    const tile = els.timelineSections.querySelector(`.timeline-tile[data-file-id="${id}"]`);
    tile?.classList.remove("selected");
    const cb = tile?.querySelector('input[type="checkbox"]');
    if (cb) cb.checked = false;
  }
  state.timelineSelected.clear();
  updateTimelineToolbar();
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

els.viewTabDuplicates.addEventListener("click", () => switchView("duplicates"));
els.viewTabTimeline.addEventListener("click", () => switchView("timeline"));
els.timelineScanBtn.addEventListener("click", scanTimeline);

const timelineObserver = new IntersectionObserver(
  (entries) => {
    if (entries.some((e) => e.isIntersecting)) renderMoreTimeline();
  },
  { rootMargin: "800px" }
);
timelineObserver.observe(els.timelineSentinel);
els.lightboxCloseBtn.addEventListener("click", closeLightbox);
els.lightboxPrevBtn.addEventListener("click", () => navigateLightbox(-1));
els.lightboxNextBtn.addEventListener("click", () => navigateLightbox(1));
els.lightbox.addEventListener("click", (e) => {
  if (e.target === els.lightbox) closeLightbox();
});
els.lightboxDownloadBtn.addEventListener("click", () => {
  const f = state.timelineItems[state.lightboxIndex];
  if (f) downloadFile(f);
});
els.lightboxDeleteBtn.addEventListener("click", () => {
  const f = state.timelineItems[state.lightboxIndex];
  if (f) openTimelineDeleteConfirm([f.id]);
});

els.timelineDownloadSelectedBtn.addEventListener("click", () => {
  const files = state.timelineItems.filter((f) => state.timelineSelected.has(f.id));
  downloadFiles(files);
});
els.timelineDeleteSelectedBtn.addEventListener("click", () => {
  openTimelineDeleteConfirm(Array.from(state.timelineSelected));
});
els.timelineClearSelectionBtn.addEventListener("click", clearTimelineSelection);
window.addEventListener("keydown", (e) => {
  if (els.lightbox.classList.contains("hidden")) return;
  if (e.key === "Escape") closeLightbox();
  else if (e.key === "ArrowLeft") navigateLightbox(-1);
  else if (e.key === "ArrowRight") navigateLightbox(1);
});

window.addEventListener("load", () => {
  updateSetupWarning();
  initTokenClientIfNeeded();
});
