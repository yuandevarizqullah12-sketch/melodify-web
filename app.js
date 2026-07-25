// =============================================================================
// app.js
// UI, DOM, events, player orchestration, and client-side state ONLY.
// This file never calls fetch(), never touches Firebase, and never talks to
// Firestore directly — every network concern lives in services/api.js.
// =============================================================================

import {
  initFirebase,
  searchSongs,
  getSuggestions,
  getSongsByIds,
  fetchLyrics,
  getBackendUrl,
  setBackendUrl,
} from "./services/api.js";

// -----------------------------------------------------------------------------
// Constants
// -----------------------------------------------------------------------------
const STORAGE_KEYS = {
  favorites: "melodify_favorites",
  playlists: "melodify_playlists",
  recent: "melodify_recent",
  volume: "melodify_volume",
};
const RECENT_MAX = 50;
const SUGGEST_DEBOUNCE_MS = 250;
const SEARCH_DEBOUNCE_MS = 450;

// -----------------------------------------------------------------------------
// DOM references
// -----------------------------------------------------------------------------
const els = {
  appShell: document.getElementById("appShell"),

  navHomeBtn: document.getElementById("navHomeBtn"),
  navSearchBtn: document.getElementById("navSearchBtn"),
  navFavoritesBtn: document.getElementById("navFavoritesBtn"),
  navSettingsBtn: document.getElementById("navSettingsBtn"),
  createPlaylistBtn: document.getElementById("createPlaylistBtn"),
  playlistNavList: document.getElementById("playlistNavList"),

  searchTriggerBtn: document.getElementById("searchTriggerBtn"),
  mobileSearchBtn: document.getElementById("mobileSearchBtn"),
  mobileSettingsBtn: document.getElementById("mobileSettingsBtn"),

  viewContainer: document.getElementById("viewContainer"),
  homeView: document.getElementById("homeView"),
  greetingText: document.getElementById("greetingText"),

  quickActionShuffleAll: document.getElementById("quickActionShuffleAll"),
  quickActionFavorites: document.getElementById("quickActionFavorites"),
  quickActionNewPlaylist: document.getElementById("quickActionNewPlaylist"),

  recentSection: document.getElementById("recentSection"),
  recentGrid: document.getElementById("recentGrid"),
  playlistsSection: document.getElementById("playlistsSection"),
  playlistsGrid: document.getElementById("playlistsGrid"),
  favoritesSection: document.getElementById("favoritesSection"),
  favoritesGrid: document.getElementById("favoritesGrid"),

  favoritesView: document.getElementById("favoritesView"),
  favoritesViewList: document.getElementById("favoritesViewList"),

  playlistDetailView: document.getElementById("playlistDetailView"),
  playlistDetailArt: document.getElementById("playlistDetailArt"),
  playlistDetailTitle: document.getElementById("playlistDetailTitle"),
  playlistDetailCount: document.getElementById("playlistDetailCount"),
  playlistDetailPlayBtn: document.getElementById("playlistDetailPlayBtn"),
  playlistDetailDeleteBtn: document.getElementById("playlistDetailDeleteBtn"),
  playlistDetailList: document.getElementById("playlistDetailList"),

  searchOverlay: document.getElementById("searchOverlay"),
  searchInput: document.getElementById("searchInput"),
  searchCloseBtn: document.getElementById("searchCloseBtn"),
  searchSuggestions: document.getElementById("searchSuggestions"),
  searchStatus: document.getElementById("searchStatus"),
  searchResultsList: document.getElementById("searchResultsList"),

  nowPlayingSheet: document.getElementById("nowPlayingSheet"),
  collapseSheetBtn: document.getElementById("collapseSheetBtn"),
  sheetContextLabel: document.getElementById("sheetContextLabel"),
  videoWrap: document.getElementById("videoWrap"),
  sheetArtImg: document.getElementById("sheetArtImg"),
  sheetTitleText: document.getElementById("sheetTitleText"),
  sheetArtistText: document.getElementById("sheetArtistText"),
  sheetCurrentTime: document.getElementById("sheetCurrentTime"),
  sheetDuration: document.getElementById("sheetDuration"),

  lyricsPanel: document.getElementById("lyricsPanel"),
  lyricsPanelCloseBtn: document.getElementById("lyricsPanelCloseBtn"),
  lyricsPanelBody: document.getElementById("lyricsPanelBody"),

  playerBar: document.getElementById("playerBar"),
  playerBarTrackTrigger: document.getElementById("playerBarTrackTrigger"),
  barArtImg: document.getElementById("barArtImg"),
  barTitleText: document.getElementById("barTitleText"),
  barArtistText: document.getElementById("barArtistText"),
  barCurrentTime: document.getElementById("barCurrentTime"),
  barDuration: document.getElementById("barDuration"),
  expandPlayerBtn: document.getElementById("expandPlayerBtn"),

  playlistModal: document.getElementById("playlistModal"),
  playlistModalCloseBtn: document.getElementById("playlistModalCloseBtn"),
  playlistModalList: document.getElementById("playlistModalList"),
  playlistModalEmptyHint: document.getElementById("playlistModalEmptyHint"),
  playlistModalCreateForm: document.getElementById("playlistModalCreateForm"),
  playlistModalNewName: document.getElementById("playlistModalNewName"),

  settingsModal: document.getElementById("settingsModal"),
  settingsCloseBtn: document.getElementById("settingsCloseBtn"),
  settingsForm: document.getElementById("settingsForm"),
  backendUrlInput: document.getElementById("backendUrlInput"),

  toastContainer: document.getElementById("toastContainer"),
};

/** Every element carrying a given "mirrored" control class (bar + sheet). */
function allWithClass(cls) {
  return Array.from(document.getElementsByClassName(cls));
}

// -----------------------------------------------------------------------------
// State
// -----------------------------------------------------------------------------
const state = {
  queue: [], // array of song objects representing the active playback context
  queueOrder: [], // indices into `queue`, reordered when shuffling
  queuePosition: -1, // position within queueOrder
  currentSong: null,
  isPlaying: false,
  shuffle: false,
  repeatMode: "off", // 'off' | 'all' | 'one'
  mode: "song", // 'song' | 'video'
  volume: 80,
  muted: false,
  lastVolume: 80,
  duration: 0,
  currentTime: 0,

  favorites: new Set(),
  playlists: [], // [{ id, name, createdAt, songs: [{ videoId, addedAt }] }]
  recent: [], // [videoId, ...] most recent first

  currentView: "home",
  activePlaylistId: null,
  playlistModalTargetVideoId: null,

  songCache: new Map(), // videoId -> song object, populated as songs are seen

  searchQuery: "",
  searchResults: [],
  lyricsData: null,
};

let ytPlayer = null;
let ytReady = false;
let progressTimer = null;

// -----------------------------------------------------------------------------
// Storage
// -----------------------------------------------------------------------------
function loadStorage() {
  try {
    const favs = JSON.parse(localStorage.getItem(STORAGE_KEYS.favorites) || "[]");
    state.favorites = new Set(Array.isArray(favs) ? favs : []);
  } catch {
    state.favorites = new Set();
  }
  try {
    const playlists = JSON.parse(localStorage.getItem(STORAGE_KEYS.playlists) || "[]");
    state.playlists = Array.isArray(playlists) ? playlists : [];
  } catch {
    state.playlists = [];
  }
  try {
    const recent = JSON.parse(localStorage.getItem(STORAGE_KEYS.recent) || "[]");
    state.recent = Array.isArray(recent) ? recent : [];
  } catch {
    state.recent = [];
  }
  try {
    const vol = parseInt(localStorage.getItem(STORAGE_KEYS.volume), 10);
    if (!Number.isNaN(vol)) {
      state.volume = Math.min(100, Math.max(0, vol));
      state.lastVolume = state.volume;
    }
  } catch {
    /* keep default */
  }
}

function saveFavorites() {
  localStorage.setItem(STORAGE_KEYS.favorites, JSON.stringify([...state.favorites]));
}
function savePlaylists() {
  localStorage.setItem(STORAGE_KEYS.playlists, JSON.stringify(state.playlists));
}
function saveRecent() {
  localStorage.setItem(STORAGE_KEYS.recent, JSON.stringify(state.recent));
}
function saveVolume() {
  localStorage.setItem(STORAGE_KEYS.volume, String(state.volume));
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function debounce(fn, ms) {
  let handle = null;
  return (...args) => {
    clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  };
}

function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds || 0));
  const m = Math.floor(s / 60);
  const rem = s % 60;
  return `${m}:${String(rem).padStart(2, "0")}`;
}

function escapeHtml(value) {
  const div = document.createElement("div");
  div.textContent = value == null ? "" : String(value);
  return div.innerHTML;
}

function cacheSongs(songs) {
  for (const song of songs) {
    if (song && song.videoId) state.songCache.set(song.videoId, song);
  }
}

function getCachedSong(videoId) {
  return state.songCache.get(videoId) || null;
}

function fallbackThumb(song) {
  if (song && song.thumbnail) return song.thumbnail;
  return "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E%3Crect width='200' height='200' fill='%23191c22'/%3E%3C/svg%3E";
}

// -----------------------------------------------------------------------------
// Toasts
// -----------------------------------------------------------------------------
function showToast(message) {
  const toast = document.createElement("div");
  toast.className = "toast";
  toast.textContent = message;
  els.toastContainer.appendChild(toast);
  setTimeout(() => {
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 260);
  }, 2600);
}

// -----------------------------------------------------------------------------
// View routing
// -----------------------------------------------------------------------------
function setView(viewName) {
  state.currentView = viewName;

  const views = {
    home: els.homeView,
    favorites: els.favoritesView,
    playlistDetail: els.playlistDetailView,
  };

  Object.entries(views).forEach(([name, el]) => {
    if (!el) return;
    el.classList.toggle("is-active", name === viewName);
  });

  document.querySelectorAll(".nav-btn[data-view]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === viewName);
  });
  document.querySelectorAll(".tab-btn[data-view]").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.view === viewName);
  });

  els.viewContainer.scrollTop = 0;

  if (viewName === "favorites") renderFavoritesView();
}

// -----------------------------------------------------------------------------
// Rendering: song rows / cards
// -----------------------------------------------------------------------------
function buildSongRow(song) {
  const row = document.createElement("div");
  row.className = "song-row";
  row.dataset.videoId = song.videoId;
  if (state.currentSong && state.currentSong.videoId === song.videoId) {
    row.classList.add("is-current");
  }
  const isFav = state.favorites.has(song.videoId);

  row.innerHTML = `
    <img class="song-row-art" src="${fallbackThumb(song)}" alt="" loading="lazy">
    <div class="song-row-text">
      <p class="song-row-title">${escapeHtml(song.title)}</p>
      <p class="song-row-artist">${escapeHtml(song.artist)}</p>
    </div>
    <span class="song-row-duration">${formatDuration(song.duration)}</span>
    <div class="song-row-actions">
      <button class="icon-btn song-row-fav-btn favorite-btn ${isFav ? "is-favorited" : ""}" data-video-id="${song.videoId}" type="button" aria-label="Toggle favorite">
        <svg class="icon" viewBox="0 0 24 24"><path d="M12 20.5s-7.5-4.6-10-9.4C.4 7.7 2 4 5.6 4c2 0 3.6 1.1 4.4 2.7C10.8 5.1 12.4 4 14.4 4 18 4 19.6 7.7 18 11.1c-2.5 4.8-10 9.4-10 9.4Z"/></svg>
      </button>
      <button class="icon-btn song-row-add-btn" data-video-id="${song.videoId}" type="button" aria-label="Add to playlist">
        <svg class="icon" viewBox="0 0 24 24"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>
      </button>
    </div>
  `;

  row.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    playFromList(row.__songList || [song], song.videoId, row.__contextLabel || song.title);
  });

  return row;
}

function renderSongList(container, songs, emptyHint, contextLabel) {
  container.innerHTML = "";
  songs.forEach((song) => {
    const row = buildSongRow(song);
    row.__songList = songs;
    row.__contextLabel = contextLabel;
    container.appendChild(row);
  });
  if (emptyHint) emptyHint.style.display = songs.length ? "none" : "block";
  container.style.display = songs.length ? "flex" : "none";
}

function buildSongCard(song) {
  const card = document.createElement("div");
  card.className = "song-card";
  card.dataset.videoId = song.videoId;
  if (state.currentSong && state.currentSong.videoId === song.videoId) {
    card.classList.add("is-current");
  }
  card.innerHTML = `
    <div class="song-card-art-wrap">
      <img src="${fallbackThumb(song)}" alt="" loading="lazy">
      <button class="song-card-play" data-video-id="${song.videoId}" type="button" aria-label="Play ${escapeHtml(song.title)}">
        <svg class="icon" viewBox="0 0 24 24"><path d="M8 5v14l12-7z"/></svg>
      </button>
    </div>
    <p class="song-card-title">${escapeHtml(song.title)}</p>
    <p class="song-card-artist">${escapeHtml(song.artist)}</p>
  `;
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    playFromList(card.__songList || [song], song.videoId, card.__contextLabel || song.title);
  });
  return card;
}

function renderSongGrid(container, songs, contextLabel) {
  container.innerHTML = "";
  songs.forEach((song) => {
    const card = buildSongCard(song);
    card.__songList = songs;
    card.__contextLabel = contextLabel;
    container.appendChild(card);
  });
}

// -----------------------------------------------------------------------------
// Rendering: Home
// -----------------------------------------------------------------------------
function renderGreeting() {
  const hour = new Date().getHours();
  let greeting = "Good evening";
  if (hour < 12) greeting = "Good morning";
  else if (hour < 18) greeting = "Good afternoon";
  els.greetingText.textContent = greeting;
}

async function renderRecent() {
  const ids = state.recent.slice(0, 12);
  els.recentSection.classList.toggle("is-empty", ids.length === 0);
  if (ids.length === 0) {
    els.recentGrid.innerHTML = "";
    return;
  }
  const cached = ids.map(getCachedSong).filter(Boolean);
  const missingIds = ids.filter((id) => !getCachedSong(id));
  let songs = cached;
  if (missingIds.length) {
    const fetched = await getSongsByIds(missingIds);
    cacheSongs(fetched);
    songs = ids.map(getCachedSong).filter(Boolean);
  }
  renderSongGrid(els.recentGrid, songs, "Recently played");
}

function renderPlaylistsGrid() {
  els.playlistsSection.classList.toggle("is-empty", state.playlists.length === 0);
  els.playlistsGrid.innerHTML = "";
  state.playlists.forEach((playlist) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "playlist-card";
    card.dataset.playlistId = playlist.id;
    const thumbs = playlist.songs
      .slice(0, 4)
      .map((s) => getCachedSong(s.videoId))
      .filter(Boolean);
    const artHtml = thumbs.length
      ? thumbs.map((s) => `<img src="${fallbackThumb(s)}" alt="">`).join("")
      : `<div class="playlist-card-art-fallback"><svg class="icon" viewBox="0 0 24 24" width="26" height="26"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg></div>`;
    card.innerHTML = `
      <div class="playlist-card-art ${thumbs.length <= 1 ? "is-single" : ""}">${artHtml}</div>
      <p class="playlist-card-title">${escapeHtml(playlist.name)}</p>
      <p class="playlist-card-count">${playlist.songs.length} song${playlist.songs.length === 1 ? "" : "s"}</p>
    `;
    card.addEventListener("click", () => openPlaylistDetail(playlist.id));
    els.playlistsGrid.appendChild(card);
  });
}

async function renderFavoritesGrid() {
  const ids = [...state.favorites];
  els.favoritesSection.classList.toggle("is-empty", ids.length === 0);
  if (ids.length === 0) {
    els.favoritesGrid.innerHTML = "";
    return;
  }
  const songs = await resolveSongs(ids);
  renderSongGrid(els.favoritesGrid, songs.slice(0, 12), "Favorites");
}

async function resolveSongs(ids) {
  const cached = ids.map(getCachedSong);
  const missingIds = ids.filter((id, i) => !cached[i]);
  if (missingIds.length) {
    const fetched = await getSongsByIds(missingIds);
    cacheSongs(fetched);
  }
  return ids.map(getCachedSong).filter(Boolean);
}

async function renderHome() {
  renderGreeting();
  await renderRecent();
  renderPlaylistsGrid();
  await renderFavoritesGrid();
}

// -----------------------------------------------------------------------------
// Rendering: Favorites view
// -----------------------------------------------------------------------------
async function renderFavoritesView() {
  const ids = [...state.favorites];
  const songs = await resolveSongs(ids);
  renderSongList(els.favoritesViewList, songs, document.getElementById("favoritesViewEmptyHint"), "Favorites");
}

// -----------------------------------------------------------------------------
// Rendering: Playlist detail view
// -----------------------------------------------------------------------------
async function openPlaylistDetail(playlistId) {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist) return;
  state.activePlaylistId = playlistId;

  els.playlistDetailTitle.textContent = playlist.name;
  els.playlistDetailCount.textContent = `${playlist.songs.length} song${playlist.songs.length === 1 ? "" : "s"}`;

  const ids = playlist.songs.map((s) => s.videoId);
  const songs = await resolveSongs(ids);

  const firstArt = songs[0] ? fallbackThumb(songs[0]) : "";
  els.playlistDetailArt.style.backgroundImage = firstArt ? `url(${firstArt})` : "none";
  els.playlistDetailArt.style.backgroundSize = "cover";
  els.playlistDetailArt.style.backgroundPosition = "center";

  renderSongList(els.playlistDetailList, songs, document.getElementById("playlistDetailEmptyHint"), playlist.name);
  els.playlistDetailView.classList.toggle("is-empty", songs.length === 0);

  state.currentView = "playlistDetail";
  Object.entries({
    home: els.homeView,
    favorites: els.favoritesView,
    playlistDetail: els.playlistDetailView,
  }).forEach(([name, el]) => el.classList.toggle("is-active", name === "playlistDetail"));
  els.viewContainer.scrollTop = 0;
}

function deleteActivePlaylist() {
  if (!state.activePlaylistId) return;
  state.playlists = state.playlists.filter((p) => p.id !== state.activePlaylistId);
  savePlaylists();
  state.activePlaylistId = null;
  showToast("Playlist deleted");
  setView("home");
  renderPlaylistsGrid();
}

// -----------------------------------------------------------------------------
// Sidebar playlist navigation list
// -----------------------------------------------------------------------------
function renderPlaylistNav() {
  els.playlistNavList.innerHTML = "";
  state.playlists.forEach((playlist) => {
    const li = document.createElement("li");
    li.className = "playlist-nav-item";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "playlist-nav-btn";
    btn.dataset.playlistId = playlist.id;
    if (state.activePlaylistId === playlist.id && state.currentView === "playlistDetail") {
      btn.classList.add("is-active");
    }
    btn.innerHTML = `${escapeHtml(playlist.name)}<small>${playlist.songs.length} song${playlist.songs.length === 1 ? "" : "s"}</small>`;
    btn.addEventListener("click", () => openPlaylistDetail(playlist.id));
    li.appendChild(btn);
    els.playlistNavList.appendChild(li);
  });
}

function refreshLibraryUI() {
  renderPlaylistNav();
  renderPlaylistsGrid();
}

// =============================================================================
// PLAYER
// =============================================================================

function currentQueueSong() {
  if (state.queuePosition < 0 || state.queuePosition >= state.queueOrder.length) return null;
  const idx = state.queueOrder[state.queuePosition];
  return state.queue[idx] || null;
}

function buildShuffleOrder(length, keepFirst) {
  const order = Array.from({ length }, (_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  if (keepFirst !== undefined) {
    const pos = order.indexOf(keepFirst);
    if (pos > 0) {
      [order[0], order[pos]] = [order[pos], order[0]];
    }
  }
  return order;
}

/** Starts playback of `videoId` from within `songList`, tagging the context. */
function playFromList(songList, videoId, contextLabel) {
  cacheSongs(songList);
  const startIndex = songList.findIndex((s) => s.videoId === videoId);
  if (startIndex === -1) return;

  state.queue = songList.slice();
  state.queueOrder = state.shuffle
    ? buildShuffleOrder(state.queue.length, startIndex)
    : state.queue.map((_, i) => i);
  state.queuePosition = state.shuffle ? 0 : startIndex;
  els.sheetContextLabel.textContent = contextLabel || "Now playing";

  loadCurrentIntoPlayer(true);
}

function addToRecent(videoId) {
  state.recent = [videoId, ...state.recent.filter((id) => id !== videoId)].slice(0, RECENT_MAX);
  saveRecent();
}

function loadCurrentIntoPlayer(autoplay) {
  const song = currentQueueSong();
  if (!song) return;
  state.currentSong = song;
  addToRecent(song.videoId);
  updateNowPlayingUI();
  state.lyricsData = null;
  renderLyricsPanel(null, true);

  if (ytReady && ytPlayer) {
    if (autoplay) {
      ytPlayer.loadVideoById(song.videoId);
    } else {
      ytPlayer.cueVideoById(song.videoId);
    }
  }

  if (els.lyricsPanel.classList.contains("is-open")) {
    loadLyricsForCurrentSong();
  }
}

function updateNowPlayingUI() {
  const song = state.currentSong;
  const title = song ? song.title : "Nothing playing";
  const artist = song ? song.artist : "Search for a song to begin";
  const art = song ? fallbackThumb(song) : fallbackThumb(null);

  els.barTitleText.textContent = title;
  els.barArtistText.textContent = artist;
  els.barArtImg.src = art;
  els.sheetTitleText.textContent = title;
  els.sheetArtistText.textContent = artist;
  els.sheetArtImg.src = art;

  const isFav = song ? state.favorites.has(song.videoId) : false;
  allWithClass("favorite-btn").forEach((btn) => {
    // Row/card favorite buttons carry their own data-video-id and manage
    // their own state elsewhere — only the two "current song" buttons
    // (bottom bar + now-playing sheet) reflect state.currentSong here.
    if (btn.dataset.videoId) return;
    btn.classList.toggle("is-favorited", isFav);
  });

  document.querySelectorAll(".song-row, .song-card").forEach((el) => {
    el.classList.toggle("is-current", !!song && el.dataset.videoId === song.videoId);
  });
  document.querySelectorAll(".song-row-fav-btn").forEach((btn) => {
    btn.classList.toggle("is-favorited", state.favorites.has(btn.dataset.videoId));
  });
}

function setPlayingUI(isPlaying) {
  state.isPlaying = isPlaying;
  els.appShell.classList.toggle("is-playing", isPlaying);
  allWithClass("play-pause-btn").forEach((btn) => {
    btn.setAttribute("aria-label", isPlaying ? "Pause" : "Play");
    const playIcon = btn.querySelector(".icon-play");
    const pauseIcon = btn.querySelector(".icon-pause");
    if (playIcon) playIcon.hidden = isPlaying;
    if (pauseIcon) pauseIcon.hidden = !isPlaying;
  });
}

function togglePlayPause() {
  if (!state.currentSong) return;
  if (!ytReady || !ytPlayer) return;
  if (state.isPlaying) {
    ytPlayer.pauseVideo();
  } else {
    ytPlayer.playVideo();
  }
}

function playNext(userTriggered) {
  if (state.queueOrder.length === 0) return;
  if (state.repeatMode === "one" && !userTriggered) {
    loadCurrentIntoPlayer(true);
    return;
  }
  const atEnd = state.queuePosition >= state.queueOrder.length - 1;
  if (atEnd) {
    if (state.repeatMode === "all") {
      state.queuePosition = 0;
    } else if (userTriggered) {
      state.queuePosition = 0;
      loadCurrentIntoPlayer(false);
      setPlayingUI(false);
      return;
    } else {
      setPlayingUI(false);
      return;
    }
  } else {
    state.queuePosition += 1;
  }
  loadCurrentIntoPlayer(true);
}

function playPrevious() {
  if (state.queueOrder.length === 0) return;
  if (state.currentTime > 3) {
    seekTo(0);
    return;
  }
  if (state.queuePosition <= 0) {
    state.queuePosition = state.repeatMode === "all" ? state.queueOrder.length - 1 : 0;
  } else {
    state.queuePosition -= 1;
  }
  loadCurrentIntoPlayer(true);
}

function toggleShuffle() {
  state.shuffle = !state.shuffle;
  allWithClass("shuffle-btn").forEach((btn) => btn.classList.toggle("is-active", state.shuffle));
  if (state.queue.length > 0) {
    const currentIdx = state.queueOrder[state.queuePosition];
    state.queueOrder = state.shuffle
      ? buildShuffleOrder(state.queue.length, currentIdx)
      : state.queue.map((_, i) => i);
    state.queuePosition = state.queueOrder.indexOf(currentIdx);
  }
  showToast(state.shuffle ? "Shuffle on" : "Shuffle off");
}

function cycleRepeat() {
  const order = ["off", "all", "one"];
  const next = order[(order.indexOf(state.repeatMode) + 1) % order.length];
  state.repeatMode = next;
  allWithClass("repeat-btn").forEach((btn) => {
    btn.classList.toggle("is-active", next !== "off");
    const dot = btn.querySelector(".repeat-one-dot");
    if (dot) dot.hidden = next !== "one";
  });
  const labels = { off: "Repeat off", all: "Repeat all", one: "Repeat one" };
  showToast(labels[next]);
}

function seekTo(seconds) {
  if (!ytReady || !ytPlayer) return;
  ytPlayer.seekTo(seconds, true);
  state.currentTime = seconds;
  updateProgressUI();
}

function updateProgressUI() {
  const duration = state.duration || 0;
  const time = state.currentTime || 0;
  const pct = duration > 0 ? Math.min(1000, Math.round((time / duration) * 1000)) : 0;

  allWithClass("seek-bar").forEach((bar) => {
    if (document.activeElement !== bar) bar.value = String(pct);
  });
  allWithClass("current-time").forEach((el) => (el.textContent = formatDuration(time)));
  allWithClass("duration-time").forEach((el) => (el.textContent = formatDuration(duration)));

  updateLyricsHighlight(time);
}

function startProgressTimer() {
  stopProgressTimer();
  progressTimer = setInterval(() => {
    if (!ytReady || !ytPlayer || !state.isPlaying) return;
    try {
      state.currentTime = ytPlayer.getCurrentTime() || 0;
      state.duration = ytPlayer.getDuration() || state.duration;
      updateProgressUI();
    } catch {
      /* player not ready for this tick */
    }
  }, 500);
}
function stopProgressTimer() {
  if (progressTimer) clearInterval(progressTimer);
  progressTimer = null;
}

function setVolume(value) {
  state.volume = Math.min(100, Math.max(0, value));
  state.muted = state.volume === 0;
  if (ytReady && ytPlayer) ytPlayer.setVolume(state.volume);
  allWithClass("volume-slider").forEach((slider) => {
    if (document.activeElement !== slider) slider.value = String(state.volume);
  });
  allWithClass("volume-btn").forEach((btn) => {
    const on = btn.querySelector(".icon-vol-on");
    const off = btn.querySelector(".icon-vol-off");
    if (on) on.hidden = state.muted;
    if (off) off.hidden = !state.muted;
  });
  saveVolume();
}

function toggleMute() {
  if (state.muted) {
    setVolume(state.lastVolume || 50);
  } else {
    state.lastVolume = state.volume || state.lastVolume;
    setVolume(0);
  }
}

function toggleFavoriteCurrent() {
  if (!state.currentSong) return;
  toggleFavoriteId(state.currentSong.videoId);
}

function toggleFavoriteId(videoId) {
  if (state.favorites.has(videoId)) {
    state.favorites.delete(videoId);
    showToast("Removed from favorites");
  } else {
    state.favorites.add(videoId);
    showToast("Added to favorites");
  }
  saveFavorites();
  updateNowPlayingUI();
  if (state.currentView === "home") renderFavoritesGrid();
  if (state.currentView === "favorites") renderFavoritesView();
}

function toggleMode() {
  state.mode = state.mode === "song" ? "video" : "song";
  els.appShell.classList.toggle("song-mode", state.mode === "song");
  allWithClass("mode-toggle-btn").forEach((btn) => {
    btn.classList.toggle("is-active", state.mode === "video");
    btn.setAttribute("aria-label", state.mode === "song" ? "Switch to video mode" : "Switch to song mode");
    const label = btn.querySelector(".mode-toggle-label");
    if (label) label.textContent = state.mode === "song" ? "Video" : "Song";
  });
}

// -----------------------------------------------------------------------------
// YouTube IFrame Player
// -----------------------------------------------------------------------------
window.onYouTubeIframeAPIReady = function onYouTubeIframeAPIReady() {
  ytPlayer = new YT.Player("youtubePlayer", {
    height: "100%",
    width: "100%",
    playerVars: {
      playsinline: 1,
      rel: 0,
      modestbranding: 1,
      controls: 0,
      disablekb: 1,
    },
    events: {
      onReady: handleYtReady,
      onStateChange: handleYtStateChange,
    },
  });
};

function handleYtReady() {
  ytReady = true;
  ytPlayer.setVolume(state.volume);
  startProgressTimer();
}

function handleYtStateChange(event) {
  if (event.data === YT.PlayerState.PLAYING) {
    setPlayingUI(true);
    state.duration = ytPlayer.getDuration() || state.duration;
  } else if (event.data === YT.PlayerState.PAUSED) {
    setPlayingUI(false);
  } else if (event.data === YT.PlayerState.ENDED) {
    setPlayingUI(false);
    playNext(false);
  }
}

// =============================================================================
// SEARCH
// =============================================================================
function openSearchOverlay() {
  els.searchOverlay.classList.add("is-open");
  els.searchOverlay.setAttribute("aria-hidden", "false");
  setTimeout(() => els.searchInput.focus(), 60);
}
function closeSearchOverlay() {
  els.searchOverlay.classList.remove("is-open");
  els.searchOverlay.setAttribute("aria-hidden", "true");
}

function setSearchStatus(text, loading) {
  els.searchStatus.textContent = text || "";
  els.searchStatus.classList.toggle("is-visible", !!text);
  els.searchStatus.classList.toggle("is-loading", !!loading);
}

function renderSuggestions(suggestions) {
  els.searchSuggestions.innerHTML = "";
  suggestions.forEach((item) => {
    const li = document.createElement("li");
    li.className = "suggestion-item";
    li.dataset.query = item.query;
    li.innerHTML = `
      <svg class="icon" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>
      <span>${escapeHtml(item.label)}</span>
    `;
    li.addEventListener("click", () => {
      els.searchInput.value = item.query;
      runSearch(item.query);
    });
    els.searchSuggestions.appendChild(li);
  });
}

const debouncedSuggest = debounce(async (value) => {
  if (!value.trim()) {
    els.searchSuggestions.innerHTML = "";
    return;
  }
  try {
    const suggestions = await getSuggestions(value);
    renderSuggestions(suggestions);
  } catch {
    els.searchSuggestions.innerHTML = "";
  }
}, SUGGEST_DEBOUNCE_MS);

const debouncedSearch = debounce((value) => runSearch(value), SEARCH_DEBOUNCE_MS);

async function runSearch(rawQuery) {
  const value = (rawQuery || "").trim();
  state.searchQuery = value;
  if (!value) {
    els.searchResultsList.innerHTML = "";
    setSearchStatus("", false);
    return;
  }
  setSearchStatus("Searching…", true);
  els.searchResultsList.innerHTML = "";
  try {
    const songs = await searchSongs(value);
    cacheSongs(songs);
    state.searchResults = songs;
    if (songs.length === 0) {
      setSearchStatus("No results found.", false);
    } else {
      setSearchStatus("", false);
      renderSongList(els.searchResultsList, songs, null, `Search: ${value}`);
    }
  } catch (err) {
    setSearchStatus("Search failed. Check your backend URL in Settings.", false);
  }
}

// =============================================================================
// LYRICS
// =============================================================================
function updateLyricsHighlight(time) {
  if (!state.lyricsData || !state.lyricsData.synced) return;
  const lines = els.lyricsPanelBody.querySelectorAll(".lyrics-line[data-time]");
  let activeIndex = -1;
  lines.forEach((line, i) => {
    const t = parseFloat(line.dataset.time);
    if (t <= time) activeIndex = i;
  });
  lines.forEach((line, i) => line.classList.toggle("is-active", i === activeIndex));
  if (activeIndex >= 0 && els.lyricsPanel.classList.contains("is-open")) {
    const activeLine = lines[activeIndex];
    if (activeLine) {
      activeLine.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }
}

function renderLyricsPanel(data, loading) {
  if (loading) {
    els.lyricsPanelBody.innerHTML = `<p class="lyrics-empty">Loading lyrics…</p>`;
    return;
  }
  if (!data) {
    els.lyricsPanelBody.innerHTML = `<p class="lyrics-empty" id="lyricsEmptyState">${
      state.currentSong ? "No lyrics found for this song." : "Play a song to see its lyrics."
    }</p>`;
    return;
  }
  if (data.synced && data.synced.length) {
    els.lyricsPanelBody.innerHTML = data.synced
      .map((line) => `<p class="lyrics-line" data-time="${line.time}">${escapeHtml(line.text) || "&nbsp;"}</p>`)
      .join("");
  } else if (data.plain) {
    els.lyricsPanelBody.innerHTML = `<p class="lyrics-plain">${escapeHtml(data.plain)}</p>`;
  } else {
    els.lyricsPanelBody.innerHTML = `<p class="lyrics-empty">No lyrics found for this song.</p>`;
  }
}

async function loadLyricsForCurrentSong() {
  const song = state.currentSong;
  if (!song) {
    renderLyricsPanel(null, false);
    return;
  }
  renderLyricsPanel(null, true);
  try {
    const data = await fetchLyrics({ title: song.title, artist: song.artist, duration: song.duration });
    if (state.currentSong && state.currentSong.videoId === song.videoId) {
      state.lyricsData = data;
      renderLyricsPanel(data, false);
    }
  } catch {
    renderLyricsPanel(null, false);
  }
}

function openLyricsPanel() {
  els.lyricsPanel.classList.add("is-open");
  els.lyricsPanel.setAttribute("aria-hidden", "false");
  if (!state.lyricsData) loadLyricsForCurrentSong();
}
function closeLyricsPanel() {
  els.lyricsPanel.classList.remove("is-open");
  els.lyricsPanel.setAttribute("aria-hidden", "true");
}
function toggleLyricsPanel() {
  if (els.lyricsPanel.classList.contains("is-open")) {
    closeLyricsPanel();
  } else {
    openLyricsPanel();
  }
}

// =============================================================================
// NOW PLAYING SHEET (mobile / video stage)
// =============================================================================
function openNowPlayingSheet() {
  els.nowPlayingSheet.classList.add("is-open");
  els.nowPlayingSheet.setAttribute("aria-hidden", "false");
}
function closeNowPlayingSheet() {
  els.nowPlayingSheet.classList.remove("is-open");
  els.nowPlayingSheet.setAttribute("aria-hidden", "true");
}

// =============================================================================
// PLAYLIST MODAL
// =============================================================================
function openPlaylistModal(videoId) {
  state.playlistModalTargetVideoId = videoId;
  renderPlaylistModalList();
  els.playlistModal.classList.add("is-open");
  els.playlistModal.setAttribute("aria-hidden", "false");
}
function closePlaylistModal() {
  els.playlistModal.classList.remove("is-open");
  els.playlistModal.setAttribute("aria-hidden", "true");
  state.playlistModalTargetVideoId = null;
}

function renderPlaylistModalList() {
  els.playlistModalList.innerHTML = "";
  els.playlistModalEmptyHint.style.display = state.playlists.length ? "none" : "block";
  const targetId = state.playlistModalTargetVideoId;

  state.playlists.forEach((playlist) => {
    const contains = playlist.songs.some((s) => s.videoId === targetId);
    const li = document.createElement("li");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `modal-playlist-item ${contains ? "contains-song" : ""}`;
    btn.innerHTML = `
      <span>${escapeHtml(playlist.name)}</span>
      <svg class="icon" viewBox="0 0 24 24"><path d="M20 6 9 17l-5-5"/></svg>
    `;
    btn.addEventListener("click", () => {
      toggleSongInPlaylist(playlist.id, targetId);
      renderPlaylistModalList();
    });
    li.appendChild(btn);
    els.playlistModalList.appendChild(li);
  });
}

function createPlaylist(name) {
  const trimmed = (name || "").trim();
  if (!trimmed) return null;
  const playlist = {
    id: `pl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    name: trimmed,
    createdAt: Date.now(),
    songs: [],
  };
  state.playlists.push(playlist);
  savePlaylists();
  refreshLibraryUI();
  return playlist;
}

function toggleSongInPlaylist(playlistId, videoId) {
  const playlist = state.playlists.find((p) => p.id === playlistId);
  if (!playlist || !videoId) return;
  const idx = playlist.songs.findIndex((s) => s.videoId === videoId);
  if (idx >= 0) {
    playlist.songs.splice(idx, 1);
    showToast(`Removed from ${playlist.name}`);
  } else {
    playlist.songs.push({ videoId, addedAt: Date.now() });
    showToast(`Added to ${playlist.name}`);
  }
  savePlaylists();
  refreshLibraryUI();
  if (state.currentView === "playlistDetail" && state.activePlaylistId === playlistId) {
    openPlaylistDetail(playlistId);
  }
}

// =============================================================================
// SETTINGS MODAL
// =============================================================================
function openSettingsModal() {
  els.backendUrlInput.value = getBackendUrl();
  els.settingsModal.classList.add("is-open");
  els.settingsModal.setAttribute("aria-hidden", "false");
}
function closeSettingsModal() {
  els.settingsModal.classList.remove("is-open");
  els.settingsModal.setAttribute("aria-hidden", "true");
}

// =============================================================================
// EVENT WIRING
// =============================================================================
function wireNavigation() {
  els.navHomeBtn.addEventListener("click", () => setView("home"));
  els.navFavoritesBtn.addEventListener("click", () => setView("favorites"));
  els.navSearchBtn.addEventListener("click", openSearchOverlay);
  els.navSettingsBtn.addEventListener("click", openSettingsModal);
  els.mobileSearchBtn.addEventListener("click", openSearchOverlay);
  els.mobileSettingsBtn.addEventListener("click", openSettingsModal);

  document.querySelectorAll(".tab-btn[data-view]").forEach((btn) => {
    btn.addEventListener("click", () => setView(btn.dataset.view));
  });

  els.createPlaylistBtn.addEventListener("click", () => openPlaylistModal(null));
}

function wireQuickActions() {
  els.quickActionShuffleAll.addEventListener("click", async () => {
    if (state.recent.length === 0) {
      showToast("Nothing to shuffle yet");
      return;
    }
    const songs = await resolveSongs(state.recent);
    if (songs.length === 0) return;
    if (!state.shuffle) toggleShuffle();
    playFromList(songs, songs[0].videoId, "Shuffling recent");
  });

  els.quickActionFavorites.addEventListener("click", async () => {
    const ids = [...state.favorites];
    if (ids.length === 0) {
      showToast("No favorites yet");
      return;
    }
    const songs = await resolveSongs(ids);
    playFromList(songs, songs[0].videoId, "Favorites");
  });

  els.quickActionNewPlaylist.addEventListener("click", () => openPlaylistModal(null));
}

function wireSearch() {
  els.searchTriggerBtn.addEventListener("click", openSearchOverlay);
  els.searchCloseBtn.addEventListener("click", closeSearchOverlay);
  els.searchOverlay.addEventListener("click", (event) => {
    if (event.target === els.searchOverlay) closeSearchOverlay();
  });

  els.searchInput.addEventListener("input", (event) => {
    const value = event.target.value;
    debouncedSuggest(value);
    debouncedSearch(value);
  });

  els.searchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      runSearch(els.searchInput.value);
    } else if (event.key === "Escape") {
      closeSearchOverlay();
    }
  });
}

function wirePlaylistModal() {
  els.playlistModalCloseBtn.addEventListener("click", closePlaylistModal);
  els.playlistModal.addEventListener("click", (event) => {
    if (event.target === els.playlistModal) closePlaylistModal();
  });
  els.playlistModalCreateForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const name = els.playlistModalNewName.value;
    const playlist = createPlaylist(name);
    if (playlist) {
      els.playlistModalNewName.value = "";
      if (state.playlistModalTargetVideoId) {
        toggleSongInPlaylist(playlist.id, state.playlistModalTargetVideoId);
      }
      renderPlaylistModalList();
      showToast(`Created "${playlist.name}"`);
    }
  });
}

function wireSettingsModal() {
  els.settingsCloseBtn.addEventListener("click", closeSettingsModal);
  els.settingsModal.addEventListener("click", (event) => {
    if (event.target === els.settingsModal) closeSettingsModal();
  });
  els.settingsForm.addEventListener("submit", (event) => {
    event.preventDefault();
    setBackendUrl(els.backendUrlInput.value);
    showToast("Settings saved");
    closeSettingsModal();
  });
}

function wirePlaylistDetail() {
  els.playlistDetailPlayBtn.addEventListener("click", async () => {
    const playlist = state.playlists.find((p) => p.id === state.activePlaylistId);
    if (!playlist || playlist.songs.length === 0) return;
    const songs = await resolveSongs(playlist.songs.map((s) => s.videoId));
    if (songs.length) playFromList(songs, songs[0].videoId, playlist.name);
  });
  els.playlistDetailDeleteBtn.addEventListener("click", deleteActivePlaylist);
}

function wireLyrics() {
  els.lyricsPanelCloseBtn.addEventListener("click", closeLyricsPanel);
  allWithClass("lyrics-btn").forEach((btn) => btn.addEventListener("click", toggleLyricsPanel));
}

function wireNowPlayingSheet() {
  els.expandPlayerBtn.addEventListener("click", openNowPlayingSheet);
  els.collapseSheetBtn.addEventListener("click", closeNowPlayingSheet);
  els.playerBarTrackTrigger.addEventListener("click", () => {
    if (state.currentSong) openNowPlayingSheet();
  });
}

function wirePlayerControls() {
  allWithClass("play-pause-btn").forEach((btn) => btn.addEventListener("click", togglePlayPause));
  allWithClass("next-btn").forEach((btn) => btn.addEventListener("click", () => playNext(true)));
  allWithClass("prev-btn").forEach((btn) => btn.addEventListener("click", playPrevious));
  allWithClass("shuffle-btn").forEach((btn) => btn.addEventListener("click", toggleShuffle));
  allWithClass("repeat-btn").forEach((btn) => btn.addEventListener("click", cycleRepeat));
  allWithClass("mode-toggle-btn").forEach((btn) => btn.addEventListener("click", toggleMode));
  allWithClass("favorite-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const targetId = event.currentTarget.dataset.videoId;
      if (targetId) {
        toggleFavoriteId(targetId);
      } else {
        toggleFavoriteCurrent();
      }
    });
  });
  allWithClass("add-to-playlist-btn").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      const targetId = event.currentTarget.dataset.videoId || (state.currentSong && state.currentSong.videoId);
      if (targetId) openPlaylistModal(targetId);
    });
  });

  allWithClass("seek-bar").forEach((bar) => {
    bar.addEventListener("input", () => {
      const pct = Number(bar.value) / 1000;
      const time = pct * (state.duration || 0);
      allWithClass("current-time").forEach((el) => (el.textContent = formatDuration(time)));
    });
    bar.addEventListener("change", () => {
      const pct = Number(bar.value) / 1000;
      seekTo(pct * (state.duration || 0));
    });
  });

  allWithClass("volume-slider").forEach((slider) => {
    slider.addEventListener("input", () => setVolume(Number(slider.value)));
  });
  allWithClass("volume-btn").forEach((btn) => btn.addEventListener("click", toggleMute));
}

function wireDelegatedSongActions() {
  // Handles dynamically-rendered song-card play buttons and song-row action
  // buttons via a single delegated listener on the document.
  document.addEventListener("click", (event) => {
    const playBtn = event.target.closest(".song-card-play");
    if (playBtn) {
      event.stopPropagation();
      const card = playBtn.closest(".song-card");
      const list = card && card.__songList;
      if (list) playFromList(list, playBtn.dataset.videoId, card.__contextLabel);
      return;
    }
    const favBtn = event.target.closest(".song-row-fav-btn");
    if (favBtn) {
      event.stopPropagation();
      toggleFavoriteId(favBtn.dataset.videoId);
      return;
    }
    const addBtn = event.target.closest(".song-row-add-btn");
    if (addBtn) {
      event.stopPropagation();
      openPlaylistModal(addBtn.dataset.videoId);
    }
  });
}

function wireKeyboardShortcuts() {
  document.addEventListener("keydown", (event) => {
    const tag = (event.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") {
      if (event.key === "Escape") event.target.blur();
      return;
    }
    switch (event.key) {
      case " ":
        event.preventDefault();
        togglePlayPause();
        break;
      case "ArrowRight":
        if (state.currentSong) seekTo(Math.min(state.duration, state.currentTime + 5));
        break;
      case "ArrowLeft":
        if (state.currentSong) seekTo(Math.max(0, state.currentTime - 5));
        break;
      case "ArrowUp":
        event.preventDefault();
        setVolume(state.volume + 5);
        break;
      case "ArrowDown":
        event.preventDefault();
        setVolume(state.volume - 5);
        break;
      case "n":
        playNext(true);
        break;
      case "p":
        playPrevious();
        break;
      case "m":
        toggleMute();
        break;
      case "f":
        toggleFavoriteCurrent();
        break;
      case "l":
        toggleLyricsPanel();
        break;
      case "v":
        toggleMode();
        break;
      case "Escape":
        closeSearchOverlay();
        closeNowPlayingSheet();
        closeLyricsPanel();
        closePlaylistModal();
        closeSettingsModal();
        break;
      default:
        break;
    }
  });
}

// =============================================================================
// INIT
// =============================================================================
function applyInitialPlayerUI() {
  allWithClass("shuffle-btn").forEach((btn) => btn.classList.toggle("is-active", state.shuffle));
  allWithClass("repeat-btn").forEach((btn) => btn.classList.toggle("is-active", state.repeatMode !== "off"));
  els.appShell.classList.toggle("song-mode", state.mode === "song");
  setVolume(state.volume);
  updateNowPlayingUI();
  updateProgressUI();
}

function init() {
  loadStorage();
  initFirebase();

  wireNavigation();
  wireQuickActions();
  wireSearch();
  wirePlaylistModal();
  wireSettingsModal();
  wirePlaylistDetail();
  wireLyrics();
  wireNowPlayingSheet();
  wirePlayerControls();
  wireDelegatedSongActions();
  wireKeyboardShortcuts();

  applyInitialPlayerUI();
  refreshLibraryUI();
  renderHome();
  setView("home");
}

document.addEventListener("DOMContentLoaded", init);
