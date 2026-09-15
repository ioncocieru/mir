// =====================================================================
// MIR — joc de cărți online (variantă tip Durak: 6 de inimă deschide,
// ataci/aperi cu cărți egale sau mai mari, cine nu poate ia tot ce e pe
// masă, ultimul rămas cu cărți pierde). Plus mecanica de onestitate:
// oricine poate declara "Am terminat" — dacă minte și e prins, ia 6
// cărți penalizare; dacă acuzația e falsă, acuzatorul ia el penalizarea.
// Sincronizare realtime prin Supabase.
// =====================================================================

// ---------------------- CONFIG & CLIENT SUPABASE ----------------------
const cfg = window.MIR_CONFIG || {};
let supa = null;
if (cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY && !cfg.SUPABASE_URL.startsWith("PUNE_AICI")) {
  supa = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
} else {
  console.warn("Supabase nu este configurat. Editează config.js cu datele proiectului tău.");
}

// ---------------------- CONSTANTE ----------------------
const SUITS = [
  { key: "hearts", symbol: "♥", red: true },
  { key: "diamonds", symbol: "♦", red: true },
  { key: "clubs", symbol: "♣", red: false },
  { key: "spades", symbol: "♠", red: false }
];
const RANK_LABEL = { 6: "6", 7: "7", 8: "8", 9: "9", 10: "10", 11: "J", 12: "Q", 13: "K", 14: "A" };
const RANKS = [6, 7, 8, 9, 10, 11, 12, 13, 14];
const EMOJIS = ["😄", "😂", "😮", "😡", "👍", "👎", "🃏", "🔥", "😢", "🤝", "🍀", "🙄"];
const AVATAR_COLORS = ["#c0392b", "#8e44ad", "#2980b9", "#16a085", "#d35400", "#27ae60", "#34495e", "#c9a24b"];
const PENALTY_COUNT = 6;
const MAX_STRIKES = 3;
const AUTO_RESTART_SECONDS = 10;
let autoRestartTimer = null;
let autoRestartArmedForEndedAt = null;
let takeSelectorOpen = false;
let takeSelectorCount = 4;

let myId = sessionStorage.getItem("mir_player_id");
if (!myId) {
  myId = "p_" + Math.random().toString(36).slice(2, 10);
  sessionStorage.setItem("mir_player_id", myId);
}
let myColor = AVATAR_COLORS[0];

let roomCode = null;
let isHost = false;
let realtimeChannel = null;
let latestState = null;
let pollTimer = null;
let lastChatLen = 0;

// ---------------------- UTILE ----------------------
function $(sel) { return document.querySelector(sel); }
function el(tag, cls, html) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  return e;
}
function showToast(msg, ms = 2600) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => t.classList.add("hidden"), ms);
}
function genRoomCode() {
  const digits = Math.floor(1000 + Math.random() * 9000);
  return `MIR-${digits}`;
}
function cardLabel(card) { return RANK_LABEL[card.rank]; }
function cardId(suitKey, rank) { return `${suitKey}_${rank}`; }
function suitMeta(key) { return SUITS.find(s => s.key === key); }
function deepClone(obj) { return JSON.parse(JSON.stringify(obj)); }
function nowIso() { return new Date().toISOString(); }
function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}
function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
function createShuffledDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ id: cardId(s.key, r), rank: r, suit: s.key });
  return shuffle(deck);
}

// ---------------------- SCREENS ----------------------
function showScreen(id) {
  document.querySelectorAll(".screen").forEach(s => s.classList.add("hidden"));
  $(id).classList.remove("hidden");
}

// =====================================================================
// LOBBY — nume + avatar
// =====================================================================
(function buildAvatarPicker() {
  const picker = $("#avatar-picker");
  AVATAR_COLORS.forEach((color, idx) => {
    const swatch = el("div", "avatar-swatch" + (idx === 0 ? " selected" : ""));
    swatch.style.background = color;
    swatch.addEventListener("click", () => {
      myColor = color;
      document.querySelectorAll(".avatar-swatch").forEach(s => s.classList.remove("selected"));
      swatch.classList.add("selected");
      updateAvatarPreview();
    });
    picker.appendChild(swatch);
  });
  updateAvatarPreview();
})();

function updateAvatarPreview() {
  const name = $("#input-name").value.trim() || "Tu";
  const preview = $("#avatar-preview");
  preview.style.background = myColor;
  preview.textContent = initials(name);
  $("#avatar-preview-name").textContent = name;
}
$("#input-name").addEventListener("input", updateAvatarPreview);

// =====================================================================
// SUPABASE HELPERS
// =====================================================================
async function fetchRoom(code) {
  const { data, error } = await supa.from("rooms").select("*").eq("code", code).single();
  if (error) return null;
  return data;
}
async function insertRoom(code, state) {
  const { error } = await supa.from("rooms").insert({ code, state });
  return !error;
}
async function writeState(code, state) {
  const { error } = await supa.from("rooms").update({ state, updated_at: nowIso() }).eq("code", code);
  if (error) console.error("Eroare la salvare:", error);
  return !error;
}
async function updateRoomState(mutatorFn) {
  const row = await fetchRoom(roomCode);
  if (!row) { showToast("Camera nu mai există."); return; }
  const result = mutatorFn(deepClone(row.state));
  if (!result) return;
  await writeState(roomCode, result);
  latestState = result;
  render(result);
}
function subscribeRoom(code) {
  if (!supa) return;
  if (realtimeChannel) supa.removeChannel(realtimeChannel);
  realtimeChannel = supa
    .channel("room-" + code)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "rooms", filter: `code=eq.${code}` },
      (payload) => { latestState = payload.new.state; render(latestState); })
    .subscribe();

  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    const row = await fetchRoom(code);
    if (row && JSON.stringify(row.state) !== JSON.stringify(latestState)) {
      latestState = row.state;
      render(latestState);
    }
  }, 2500);
}

// =====================================================================
// CREARE / INTRARE ÎN CAMERĂ
// =====================================================================
$("#btn-create-room").addEventListener("click", async () => {
  const name = $("#input-name").value.trim();
  if (!name) return showLobbyError("Scrie-ți numele mai întâi.");
  if (!supa) return showLobbyError("Supabase nu e configurat în config.js.");

  roomCode = genRoomCode();
  isHost = true;
  const initialState = {
    phase: "waiting",
    hostId: myId,
    players: [{ id: myId, name, color: myColor, hand: [], out: false, claimedFinished: false, finishOrder: null, wins: 0, strikes: 0, eliminated: false }],
    order: [],
    talon: [],
    pile: [],
    discard: [],
    turnIndex: 0,
    mustOpenWithSixHearts: true,
    chat: [{ author: "Sistem", text: `${name} a creat camera.`, ts: nowIso(), system: true }],
    loserId: null,
    winnersOrder: []
  };
  const ok = await insertRoom(roomCode, initialState);
  if (!ok) return showLobbyError("Nu am putut crea camera. Încearcă din nou.");
  latestState = initialState;
  subscribeRoom(roomCode);
  enterWaitingRoom();
});

$("#btn-join-room").addEventListener("click", async () => {
  const name = $("#input-name").value.trim();
  const code = $("#input-room-code").value.trim().toUpperCase();
  if (!name) return showLobbyError("Scrie-ți numele mai întâi.");
  if (!code) return showLobbyError("Scrie codul camerei.");
  if (!supa) return showLobbyError("Supabase nu e configurat în config.js.");

  const row = await fetchRoom(code);
  if (!row) return showLobbyError("Nu există nicio cameră cu acest cod.");
  const state = row.state;
  if (state.phase !== "waiting") return showLobbyError("Jocul din această cameră a început deja.");
  if (state.players.length >= 5) return showLobbyError("Camera e plină (maxim 5 jucători).");
  if (state.players.some(p => p.name.toLowerCase() === name.toLowerCase())) {
    return showLobbyError("Există deja un jucător cu acest nume în cameră.");
  }

  state.players.push({ id: myId, name, color: myColor, hand: [], out: false, claimedFinished: false, finishOrder: null, wins: 0, strikes: 0, eliminated: false });
  state.chat.push({ author: "Sistem", text: `${name} s-a alăturat camerei.`, ts: nowIso(), system: true });
  roomCode = code;
  isHost = (state.hostId === myId);
  await writeState(roomCode, state);
  latestState = state;
  subscribeRoom(roomCode);
  enterWaitingRoom();
});

function showLobbyError(msg) { $("#lobby-error").textContent = msg; }

function enterWaitingRoom() {
  $("#waiting-room-code").textContent = roomCode;
  showScreen("#screen-waiting");
  render(latestState);
}

$("#btn-copy-code").addEventListener("click", () => {
  navigator.clipboard.writeText(roomCode).then(() => showToast("Cod copiat!"));
});

$("#btn-start-game").addEventListener("click", async () => {
  await updateRoomState((state) => {
    if (state.hostId !== myId) return null;
    if (state.players.length < 2) { showToast("Trebuie minim 2 jucători."); return null; }
    return startGameLogic(state);
  });
});

function startGameLogic(state) {
  const eligible = state.players.filter(p => !p.eliminated);
  if (eligible.length < 2) {
    state.chat.push({ author: "Sistem", text: `Nu mai sunt destui jucători rămași (neeliminați) pentru o rundă nouă.`, system: true, ts: nowIso() });
    return state;
  }

  const deck = createShuffledDeck();
  const base = Math.floor(deck.length / eligible.length);

  state.players = state.players.map(p => {
    if (p.eliminated) return { ...p, hand: [], out: true, claimedFinished: false, finishOrder: null };
    return { ...p, hand: [], out: false, claimedFinished: false, finishOrder: null };
  });

  const eligibleRefs = state.players.filter(p => !p.eliminated);
  for (let i = 0; i < base; i++) {
    for (const p of eligibleRefs) p.hand.push(deck.pop());
  }
  const talon = deck.splice(0, deck.length); // ce rămâne (0 sau puține cărți) devine rezervă pe masă

  const order = eligibleRefs.map(p => p.id);
  let starterIdx = 0;
  eligibleRefs.forEach((p, idx) => { if (p.hand.some(c => c.suit === "hearts" && c.rank === 6)) starterIdx = idx; });

  state.phase = "playing";
  state.order = order;
  state.talon = talon;
  state.pile = [];
  state.discard = [];
  state.turnIndex = starterIdx;
  state.mustOpenWithSixHearts = true;
  state.loserId = null;
  state.winnersOrder = [];
  state.chat.push({ author: "Sistem", text: `Rundă nouă! Fiecare din cei ${eligible.length} jucători activi are ${base} cărți. ${eligibleRefs[starterIdx].name} deschide cu 6 de inimă.`, ts: nowIso(), system: true });
  return state;
}

// =====================================================================
// LOGICĂ DE JOC
// =====================================================================
function activePlayers(state) { return state.players.filter(p => !p.out); }

function nextActiveIndex(state, fromIndex) {
  const n = state.order.length;
  for (let i = 1; i <= n; i++) {
    const idx = (fromIndex + i) % n;
    const p = state.players.find(pl => pl.id === state.order[idx]);
    if (p && !p.out && !p.claimedFinished) return idx;
  }
  return fromIndex;
}

function markPlayerOut(state, player) {
  player.out = true;
  player.claimedFinished = false;
  const finishedCount = state.players.filter(p => p.out).length;
  player.finishOrder = finishedCount;
  state.winnersOrder.push(player.id);
  state.chat.push({ author: "Sistem", text: `🎉 ${player.name} a scăpat de toate cărțile!`, ts: nowIso(), system: true });
}

// ia cărți de penalizare: întâi din rezerva de pe masă, apoi random de la ceilalți jucători activi
function grabPenaltyCards(state, targetPlayer, count) {
  let given = 0;
  const notes = [];
  while (given < count && state.talon.length > 0) {
    targetPlayer.hand.push(state.talon.pop());
    given++;
  }
  if (given < count) {
    let donors = state.players.filter(p => p.id !== targetPlayer.id && !p.out && p.hand.length > 0);
    while (given < count && donors.length > 0) {
      const donorIdx = Math.floor(Math.random() * donors.length);
      const donor = donors[donorIdx];
      const cardIdx = Math.floor(Math.random() * donor.hand.length);
      const [card] = donor.hand.splice(cardIdx, 1);
      targetPlayer.hand.push(card);
      given++;
      notes.push(donor.name);
      if (donor.hand.length === 0) {
        markPlayerOut(state, donor);
        donors = donors.filter(d => d.id !== donor.id);
      } else if (donor.hand.length === 0) {
        donors = donors.filter(d => d.id !== donor.id);
      }
    }
  }
  return { given, notes };
}

function checkEndCondition(state) {
  const active = activePlayers(state);
  if (active.length <= 1) {
    state.phase = "ended";
    state.loserId = active.length === 1 ? active[0].id : null;
    state.players.forEach(p => {
      if (!p.eliminated && p.id !== state.loserId) p.wins = (p.wins || 0) + 1;
    });
    if (state.loserId) {
      const loser = state.players.find(p => p.id === state.loserId);
      loser.strikes = (loser.strikes || 0) + 1;
      if (loser.strikes >= MAX_STRIKES) {
        loser.eliminated = true;
        state.chat.push({ author: "Sistem", text: `😬 ${loser.name} rămâne cu cărți și pierde runda (${loser.strikes}/${MAX_STRIKES}). ❌ A fost eliminat definitiv din acest grup!`, ts: nowIso(), system: true });
      } else {
        state.chat.push({ author: "Sistem", text: `😬 ${loser.name} rămâne cu cărți și pierde runda (${loser.strikes}/${MAX_STRIKES}).`, ts: nowIso(), system: true });
      }
    }
    return true;
  }
  return false;
}

function playCardLogic(state, playerId, cardIdToPlay) {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.out || player.claimedFinished) return null;
  if (state.order[state.turnIndex] !== playerId) { showToast("Nu e rândul tău."); return null; }

  const cardIdx = player.hand.findIndex(c => c.id === cardIdToPlay);
  if (cardIdx === -1) return null;
  const card = player.hand[cardIdx];

  if (state.mustOpenWithSixHearts) {
    if (!(card.suit === "hearts" && card.rank === 6)) { showToast("Trebuie să deschizi cu 6 de inimă."); return null; }
  } else if (state.pile.length > 0) {
    const topCard = state.pile[state.pile.length - 1];
    if (card.rank < topCard.rank) { showToast("Cartea trebuie să fie egală sau mai mare."); return null; }
  }

  player.hand.splice(cardIdx, 1);
  state.pile.push(card);
  state.mustOpenWithSixHearts = false;

  state.chat.push({ author: "Sistem", text: `${player.name} a pus ${cardLabel(card)}${suitMeta(card.suit).symbol}.`, ts: nowIso(), system: true });

  if (player.hand.length === 0) markPlayerOut(state, player);
  if (checkEndCondition(state)) return state;

  state.turnIndex = nextActiveIndex(state, state.turnIndex);
  return state;
}

function takePileLogic(state, playerId, requestedCount) {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.out || player.claimedFinished) return null;
  if (state.order[state.turnIndex] !== playerId) { showToast("Nu e rândul tău."); return null; }
  if (state.pile.length === 0) { showToast("Masa e goală — trebuie să joci o carte."); return null; }

  const minTake = Math.min(4, state.pile.length);
  const maxTake = state.pile.length;
  let count = Math.round(requestedCount);
  if (isNaN(count)) count = minTake;
  count = Math.max(minTake, Math.min(maxTake, count));

  const taken = state.pile.slice(state.pile.length - count); // ultimele `count` cărți puse
  const leftBehind = state.pile.slice(0, state.pile.length - count);

  player.hand.push(...taken);
  if (leftBehind.length > 0) {
    state.discard = (state.discard || []).concat(leftBehind);
  }
  state.pile = [];

  const extra = leftBehind.length > 0 ? ` (restul de ${leftBehind.length} au fost scoase din joc)` : "";
  state.chat.push({ author: "Sistem", text: `${player.name} ia ultimele ${count} cărți de pe masă${extra}.`, ts: nowIso(), system: true });

  state.turnIndex = nextActiveIndex(state, state.turnIndex);
  return state;
}

function declareFinishedLogic(state, playerId) {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.out || player.claimedFinished) { showToast("Deja ai anunțat asta."); return null; }

  if (player.hand.length === 0) {
    markPlayerOut(state, player);
  } else {
    const wasTurn = state.order[state.turnIndex] === playerId;
    player.claimedFinished = true;
    state.chat.push({ author: "Sistem", text: `🏁 ${player.name} spune că a terminat cărțile...`, ts: nowIso(), system: true });
    if (wasTurn) state.turnIndex = nextActiveIndex(state, state.turnIndex);
  }
  checkEndCondition(state);
  return state;
}

function verifyPlayerLogic(state, challengerId, accusedId) {
  const challenger = state.players.find(p => p.id === challengerId);
  const accused = state.players.find(p => p.id === accusedId);
  if (!challenger || !accused || challenger.id === accused.id) return null;
  if (challenger.out) { showToast("Ai terminat deja, nu mai poți verifica."); return null; }
  if (!accused.claimedFinished && !accused.out) {
    showToast("Poți verifica doar pe cineva care a zis că a terminat (sau chiar a terminat).");
    return null;
  }

  const reallyHasCards = accused.hand.length > 0;

  if (reallyHasCards) {
    // se rezolvă o singură dată: imediat scoatem "claimedFinished", deci
    // nimeni nu mai poate aplica din nou amenda pentru aceeași declarație
    accused.claimedFinished = false;
    const { given } = grabPenaltyCards(state, accused, PENALTY_COUNT);
    state.chat.push({ author: "Sistem", text: `🚨 ${challenger.name} l-a demascat pe ${accused.name} — încă avea cărți! Primește ${given} cărți penalizare.`, ts: nowIso(), system: true });
  } else {
    const { given } = grabPenaltyCards(state, challenger, PENALTY_COUNT);
    state.chat.push({ author: "Sistem", text: `${challenger.name} l-a verificat pe ${accused.name}, dar chiar nu mai avea cărți. Acuzație falsă — ${challenger.name} primește ${given} cărți penalizare.`, ts: nowIso(), system: true });
  }
  checkEndCondition(state);
  return state;
}

function findFourOfAKindRanks(hand) {
  const found = [];
  for (const r of RANKS) {
    const count = hand.filter(c => c.rank === r).length;
    if (count === 4) found.push(r);
  }
  return found;
}

function removeFourOfAKindLogic(state, playerId, rank) {
  const player = state.players.find(p => p.id === playerId);
  if (!player || player.out) return null;
  const matching = player.hand.filter(c => c.rank === rank);
  if (matching.length !== 4) { showToast("Nu ai toate cele 4 cărți de acest fel."); return null; }

  player.hand = player.hand.filter(c => c.rank !== rank);
  state.discard = (state.discard || []).concat(matching);
  state.chat.push({ author: "Sistem", text: `🃏 ${player.name} a scos careul de ${RANK_LABEL[rank]} din joc!`, ts: nowIso(), system: true });

  if (player.hand.length === 0 && !player.claimedFinished) markPlayerOut(state, player);
  checkEndCondition(state);
  return state;
}

function sendChatLogic(state, authorId, text) {
  const player = state.players.find(p => p.id === authorId);
  state.chat.push({ author: player ? player.name : "?", text, ts: nowIso(), system: false });
  if (state.chat.length > 80) state.chat = state.chat.slice(-80);
  return state;
}

function playAgainLogic(state) {
  if (state.hostId !== myId) return null;
  if (state.phase !== "ended") return null;
  return startGameLogic(state);
}

// =====================================================================
// ACȚIUNI UI
// =====================================================================
async function playCard(cid) { await updateRoomState((state) => playCardLogic(state, myId, cid)); }

$("#btn-take-pile").addEventListener("click", () => {
  const pileLen = (latestState && latestState.pile) ? latestState.pile.length : 4;
  takeSelectorCount = Math.min(4, pileLen);
  takeSelectorOpen = true;
  render(latestState);
});
$("#btn-take-cancel").addEventListener("click", () => {
  takeSelectorOpen = false;
  render(latestState);
});
$("#btn-take-minus").addEventListener("click", () => {
  const pileLen = (latestState && latestState.pile) ? latestState.pile.length : 4;
  const minTake = Math.min(4, pileLen);
  takeSelectorCount = Math.max(minTake, takeSelectorCount - 1);
  render(latestState);
});
$("#btn-take-plus").addEventListener("click", () => {
  const pileLen = (latestState && latestState.pile) ? latestState.pile.length : 4;
  takeSelectorCount = Math.min(pileLen, takeSelectorCount + 1);
  render(latestState);
});
$("#btn-take-confirm").addEventListener("click", async () => {
  const count = takeSelectorCount;
  takeSelectorOpen = false;
  await updateRoomState((state) => takePileLogic(state, myId, count));
});
$("#btn-declare-finished").addEventListener("click", async () => { await updateRoomState((state) => declareFinishedLogic(state, myId)); });
$("#btn-remove-quad").addEventListener("click", async () => {
  const me = latestState && latestState.players.find(p => p.id === myId);
  if (!me) return;
  const ranks = findFourOfAKindRanks(me.hand);
  if (!ranks.length) return;
  await updateRoomState((state) => removeFourOfAKindLogic(state, myId, ranks[0]));
});
async function verifyPlayer(accusedId) { await updateRoomState((state) => verifyPlayerLogic(state, myId, accusedId)); }

$("#btn-back-lobby").addEventListener("click", () => location.reload());
$("#btn-play-again").addEventListener("click", async () => {
  await updateRoomState((state) => playAgainLogic(state));
  showScreen("#screen-game");
});

$("#chat-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#chat-input");
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  await updateRoomState((state) => sendChatLogic(state, myId, text));
});
$("#btn-toggle-chat").addEventListener("click", () => $("#chat-panel").classList.remove("hidden"));
$("#btn-quick-emoji").addEventListener("click", () => $("#chat-panel").classList.remove("hidden"));
$("#btn-close-chat").addEventListener("click", () => $("#chat-panel").classList.add("hidden"));

$("#btn-settings").addEventListener("click", () => $("#settings-modal").classList.remove("hidden"));
$("#btn-close-settings").addEventListener("click", () => $("#settings-modal").classList.add("hidden"));
$("#btn-leave-room").addEventListener("click", () => location.reload());

(function buildEmojiRow() {
  const row = $("#emoji-row");
  EMOJIS.forEach(em => {
    const span = el("span", null, em);
    span.addEventListener("click", async () => { await updateRoomState((state) => sendChatLogic(state, myId, em)); });
    row.appendChild(span);
  });
})();

// =====================================================================
// RENDER
// =====================================================================
function render(state) {
  if (!state) return;
  if (state.phase === "waiting") {
    renderWaiting(state);
  } else if (state.phase === "playing") {
    if ($("#screen-game").classList.contains("hidden")) showScreen("#screen-game");
    renderGame(state);
  } else if (state.phase === "ended") {
    renderEnd(state);
    showScreen("#screen-end");
  }
  renderChat(state);
}

function avatarEl(player, sizeClass) {
  const circle = el("div", "avatar-circle " + sizeClass, initials(player.name));
  circle.style.background = player.color || AVATAR_COLORS[0];
  return circle;
}

function renderWaiting(state) {
  const list = $("#waiting-players");
  list.innerHTML = "";
  state.players.forEach(p => {
    const li = el("li");
    li.appendChild(avatarEl(p, "avatar-sm"));
    const nameWrap = el("span", "name-wrap", escapeHtml(p.name));
    li.appendChild(nameWrap);
    if (p.id === state.hostId) li.appendChild(el("span", "tag-host", "GAZDĂ"));
    list.appendChild(li);
  });
  const startBtn = $("#btn-start-game");
  startBtn.disabled = !(isHost && state.players.length >= 2);
  startBtn.classList.toggle("hidden", !isHost);
}

// poziții pe masa ovală: eu mereu jos, ceilalți distribuiți sus (max 4 adversari)
const SEAT_LAYOUTS = {
  1: [{ left: 50, top: 4 }],
  2: [{ left: 20, top: 14 }, { left: 80, top: 14 }],
  3: [{ left: 14, top: 32 }, { left: 50, top: 2 }, { left: 86, top: 32 }],
  4: [{ left: 10, top: 46 }, { left: 26, top: 6 }, { left: 74, top: 6 }, { left: 90, top: 46 }]
};

function renderGame(state) {
  $("#game-room-code").textContent = roomCode;
  const me = state.players.find(p => p.id === myId);
  const isMyTurn = state.order[state.turnIndex] === myId && me && !me.out && !me.claimedFinished;
  const currentP = state.players.find(p => p.id === state.order[state.turnIndex]);
  $("#turn-indicator").textContent = isMyTurn ? "Rândul tău!" : `Rândul lui ${currentP ? currentP.name : "?"}`;

  // scor sus (inclusiv jucători eliminați definitiv, cu semnul lor)
  const scoreRow = $("#score-row");
  scoreRow.innerHTML = "";
  state.players.forEach(p => {
    const chip = el("div", "score-chip");
    if (p.eliminated) chip.style.opacity = "0.5";
    chip.appendChild(avatarEl(p, "avatar-sm"));
    const label = p.eliminated
      ? `${p.name} ❌`
      : `${p.name}: ${p.wins || 0}★ (${p.strikes || 0}/${MAX_STRIKES})`;
    chip.appendChild(document.createTextNode(label));
    scoreRow.appendChild(chip);
  });

  // adversari pe masă
  const seatsLayer = $("#seats-layer");
  seatsLayer.innerHTML = "";
  const opponents = state.order.filter(pid => pid !== myId).map(pid => state.players.find(p => p.id === pid)).filter(Boolean);
  const layout = SEAT_LAYOUTS[Math.min(opponents.length, 4)] || SEAT_LAYOUTS[4];

  opponents.forEach((p, idx) => {
    const pos = layout[idx] || { left: 50, top: 50 };
    const isTurn = state.order[state.turnIndex] === p.id;
    const seat = el("div", "seat" + (isTurn ? " active-turn" : "") + (p.out ? " is-out" : ""));
    seat.style.left = pos.left + "%";
    seat.style.top = pos.top + "%";

    const ring = el("div", "avatar-ring");
    ring.appendChild(avatarEl(p, "avatar-md"));
    if (p.claimedFinished) ring.appendChild(el("div", "claim-flag", "🏁"));
    seat.appendChild(ring);

    seat.appendChild(el("div", "seat-name", escapeHtml(p.name) + (p.out ? " ✅" : "")));
    seat.appendChild(el("div", "seat-count", p.out ? "fără cărți" : `${p.hand.length} cărți`));

    const fan = el("div", "seat-fan");
    for (let i = 0; i < Math.min(p.hand.length, 8); i++) fan.appendChild(el("div", "mini-cardback"));
    seat.appendChild(fan);

    if (me && !me.out && (p.claimedFinished || p.out)) {
      const verifyBtn = el("button", "verify-btn", "🔍 Verifică");
      verifyBtn.addEventListener("click", () => verifyPlayer(p.id));
      seat.appendChild(verifyBtn);
    }

    seatsLayer.appendChild(seat);
  });

  // rezervă (talon)
  $("#talon-count").textContent = state.talon.length;
  $("#talon-stack").style.visibility = state.talon.length ? "visible" : "hidden";

  // masă centrală
  const pileEl = $("#pile-cards");
  pileEl.innerHTML = "";
  state.pile.forEach(c => pileEl.appendChild(renderCardEl(c, false)));
  $("#pile-empty-hint").classList.toggle("hidden", state.pile.length > 0);

  // mâna mea
  const handEl = $("#my-hand");
  handEl.innerHTML = "";
  if (me) {
    const topCard = state.pile.length ? state.pile[state.pile.length - 1] : null;
    me.hand.slice().sort((a, b) => a.rank - b.rank).forEach(c => {
      const canPlay = isMyTurn && (
        state.mustOpenWithSixHearts ? (c.suit === "hearts" && c.rank === 6) : (!topCard || c.rank >= topCard.rank)
      );
      const cardEl = renderCardEl(c, !canPlay);
      if (canPlay) cardEl.addEventListener("click", () => playCard(c.id));
      handEl.appendChild(cardEl);
    });
  }

  // butoane acțiune
  const canTake = isMyTurn && state.pile.length > 0 && !state.mustOpenWithSixHearts;
  if (!canTake) takeSelectorOpen = false;

  $("#btn-take-pile").classList.toggle("hidden", !canTake || takeSelectorOpen);
  const selectorEl = $("#take-selector");
  selectorEl.classList.toggle("hidden", !(canTake && takeSelectorOpen));
  if (canTake && takeSelectorOpen) {
    const minTake = Math.min(4, state.pile.length);
    const maxTake = state.pile.length;
    takeSelectorCount = Math.max(minTake, Math.min(maxTake, takeSelectorCount));
    $("#take-count-display").textContent = takeSelectorCount;
    $("#btn-take-minus").disabled = takeSelectorCount <= minTake;
    $("#btn-take-plus").disabled = takeSelectorCount >= maxTake;
  }
  $("#btn-declare-finished").classList.toggle("hidden", !(me && !me.out && !me.claimedFinished));

  const quadRanks = me && !me.out ? findFourOfAKindRanks(me.hand) : [];
  const quadBtn = $("#btn-remove-quad");
  quadBtn.classList.toggle("hidden", quadRanks.length === 0);
  if (quadRanks.length) quadBtn.textContent = `🃏 Scoate careul de ${RANK_LABEL[quadRanks[0]]}`;

  const hint = $("#my-turn-hint");
  if (isMyTurn) {
    hint.classList.remove("hidden");
    hint.textContent = state.mustOpenWithSixHearts ? "Tu deschizi jocul — joacă 6 de inimă."
      : (state.pile.length === 0 ? "Masa e goală — joacă orice carte." : "Joacă o carte egală sau mai mare, ori ia cărțile.");
  } else {
    hint.classList.add("hidden");
  }

  checkFloatingReactions(state);
}

function faceArtSVG(rank) {
  if (rank === 11) { // Valet
    return `<svg viewBox="0 0 40 56" fill="currentColor"><polygon points="20,2 27,11 13,11"/><circle cx="20" cy="17" r="7"/><path d="M9,42 Q20,26 31,42 L31,50 Q20,55 9,50 Z"/></svg>`;
  }
  if (rank === 12) { // Dama
    return `<svg viewBox="0 0 40 56" fill="currentColor"><polygon points="9,11 13,2 17,11 20,3 23,11 27,2 31,11 31,14 9,14"/><circle cx="20" cy="20" r="7"/><path d="M8,44 Q20,28 32,44 L32,51 Q20,56 8,51 Z"/></svg>`;
  }
  if (rank === 13) { // Carol / Rege
    return `<svg viewBox="0 0 40 56" fill="currentColor"><polygon points="8,13 12,3 17,11 20,2 23,11 28,3 32,13 32,16 8,16"/><circle cx="20" cy="7" r="2.3"/><circle cx="20" cy="22" r="7.5"/><path d="M7,46 Q20,29 33,46 L33,52 Q20,57 7,52 Z"/></svg>`;
  }
  if (rank === 14) { // As
    return `<svg viewBox="0 0 40 56" fill="currentColor"><polygon points="20,2 24,16 38,16 27,25 31,40 20,31 9,40 13,25 2,16 16,16"/></svg>`;
  }
  return "";
}

function renderCardEl(card, disabled) {
  const meta = suitMeta(card.suit);
  const cardEl = el("div", "playing-card" + (meta.red ? " suit-red" : "") + (disabled ? " card-disabled" : ""));
  const isFace = card.rank >= 11;
  const middle = isFace
    ? `<div class="face-art">${faceArtSVG(card.rank)}</div>`
    : `<div class="suit-symbol">${meta.symbol}</div>`;
  cardEl.innerHTML = `
    <div class="rank-top">${RANK_LABEL[card.rank]}<span class="mini-suit">${meta.symbol}</span></div>
    ${middle}
    <div class="rank-bottom">${RANK_LABEL[card.rank]}<span class="mini-suit">${meta.symbol}</span></div>
  `;
  return cardEl;
}

function renderEnd(state) {
  $("#end-title").textContent = "Runda s-a terminat";
  const list = $("#end-results");
  list.innerHTML = "";
  const winners = state.winnersOrder.map(id => state.players.find(p => p.id === id)).filter(Boolean);
  winners.forEach((p, idx) => list.appendChild(el("li", null, `${idx + 1}. ${escapeHtml(p.name)} — a scăpat de cărți`)));
  if (state.loserId) {
    const loser = state.players.find(p => p.id === state.loserId);
    if (loser) {
      const strikeText = `${loser.strikes || 0}/${MAX_STRIKES}`;
      list.appendChild(el("li", null, `😬 ${escapeHtml(loser.name)} — a rămas cu cărți (pierde) · ${strikeText} pierderi`));
    }
  }

  const eliminatedNow = state.players.filter(p => p.eliminated);
  const elimNote = $("#eliminated-note");
  if (eliminatedNow.length) {
    elimNote.textContent = `❌ Eliminați definitiv din acest grup (${MAX_STRIKES} pierderi): ` + eliminatedNow.map(p => p.name).join(", ") + ". Pot juca doar într-o cameră nouă.";
    elimNote.classList.remove("hidden");
  } else {
    elimNote.classList.add("hidden");
  }

  const eligible = state.players.filter(p => !p.eliminated);
  $("#btn-play-again").classList.toggle("hidden", !(isHost && eligible.length >= 2));
  manageAutoRestart(state, eligible);
}

// pornește automat runda următoare după un scurt countdown (declanșat doar de gazdă)
function manageAutoRestart(state, eligible) {
  const noteEl = $("#countdown-note");
  if (state.phase !== "ended" || eligible.length < 2) {
    clearInterval(autoRestartTimer);
    autoRestartTimer = null;
    autoRestartArmedForEndedAt = null;
    if (eligible.length < 2 && state.phase === "ended") {
      noteEl.textContent = "Nu mai sunt destui jucători neeliminați ca să continue jocul în această cameră.";
      noteEl.classList.remove("hidden");
    } else {
      noteEl.classList.add("hidden");
    }
    return;
  }

  const key = state.chat.length + "_" + state.loserId; // schimbă la fiecare final de rundă nou
  if (autoRestartArmedForEndedAt === key) return; // deja pornit pentru acest final
  autoRestartArmedForEndedAt = key;
  clearInterval(autoRestartTimer);

  let secondsLeft = AUTO_RESTART_SECONDS;
  noteEl.classList.remove("hidden");
  noteEl.textContent = `Runda următoare începe automat în ${secondsLeft}s...`;

  autoRestartTimer = setInterval(async () => {
    secondsLeft--;
    if (secondsLeft <= 0) {
      clearInterval(autoRestartTimer);
      autoRestartTimer = null;
      if (isHost) {
        await updateRoomState((s) => playAgainLogic(s));
      }
    } else {
      noteEl.textContent = `Runda următoare începe automat în ${secondsLeft}s...`;
    }
  }, 1000);
}

function renderChat(state) {
  const log = $("#chat-log");
  const wasAtBottom = log.scrollTop + log.clientHeight >= log.scrollHeight - 20;
  log.innerHTML = "";
  (state.chat || []).forEach(m => {
    const msg = el("div", "chat-msg" + (m.system ? " system-msg" : ""));
    if (!m.system) msg.appendChild(el("span", "chat-author", escapeHtml(m.author)));
    msg.appendChild(document.createTextNode(m.text));
    log.appendChild(msg);
  });
  if (wasAtBottom) log.scrollTop = log.scrollHeight;
}

// reacții plutitoare pentru mesaje formate dintr-un singur emoji
function checkFloatingReactions(state) {
  const chat = state.chat || [];
  if (chat.length > lastChatLen) {
    chat.slice(lastChatLen).forEach(m => {
      if (!m.system && EMOJIS.includes(m.text.trim())) spawnFloatingReaction(m.author, m.text.trim());
    });
  }
  lastChatLen = chat.length;
}
function spawnFloatingReaction(author, emoji) {
  const layer = $("#reaction-layer");
  const wrap = el("div", "floating-reaction", emoji);
  wrap.style.right = (20 + Math.random() * 40) + "px";
  wrap.style.bottom = "140px";
  layer.appendChild(wrap);
  setTimeout(() => wrap.remove(), 1900);
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

// stare inițială
lastChatLen = 0;
showScreen("#screen-lobby");
