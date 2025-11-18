// SoundscapePrototypeFinal.jsx
import React, { useEffect, useRef, useState } from "react";

/**
 * SoundscapePrototypeFinal
 *
 * Features:
 * - Grid (cols x rows) default 8x8
 * - Cursor (initializes on first navigation)
 * - Shift+Arrow region selection (continuous path, backtracking trims)
 * - Alphanumeric opens search dropdown when region active (Enter places)
 * - Library: loads public recordings from /sound-garden/recordings/manifest.json and supports file uploads
 * - Placements: groups of cells -> looping audio source, gain adjusts by min distance, panning by centroid
 * - Persistence: library metadata + placements saved to localStorage
 *
 * Limitations/things to improve:
 * - localStorage stores library metadata (for uploaded files it stores base64 data URLs; large files may exceed quota)
 * - For production, prefer IndexedDB for audio blobs
 */

export default function GridUrbanAdvanced({
  cols = 8,
  rows = 8,
  defaultRadius = 3,
}) {
  // UI state
  const [cursor, setCursor] = useState(null); // {x,y} or null
  const [region, setRegion] = useState([]); // [{x,y}, ...]
  const [regionActive, setRegionActive] = useState(false);
  const [lastRegionCell, setLastRegionCell] = useState(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlightIdx, setSearchHighlightIdx] = useState(0);

  const [library, setLibrary] = useState([]); // {id,name,src,type,buffer?}
  const [placements, setPlacements] = useState([]); // { id, cells:[{x,y}], libId, params }

  // audio
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);

  // nodes for running placements (not persisted) keyed by placement id
  const nodesRef = useRef({}); // { [placementId]: { src, gain, panner } }

  // refs for latest state in event handlers
  const cursorRef = useRef(cursor);
  const regionRef = useRef(region);
  const placementsRef = useRef(placements);
  const libraryRef = useRef(library);

  cursorRef.current = cursor;
  regionRef.current = region;
  placementsRef.current = placements;
  libraryRef.current = library;

  // localStorage keys
  const LIB_KEY = "ss_v2_library";
  const PLACEMENTS_KEY = "ss_v2_placements";

  // initialize audio context and load persisted state + public manifest
  useEffect(() => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtxRef.current = new Ctx();
    masterGainRef.current = audioCtxRef.current.createGain();
    masterGainRef.current.gain.value = 1;
    masterGainRef.current.connect(audioCtxRef.current.destination);

    // // load persisted library metadata
    const libRaw = localStorage.getItem(LIB_KEY);
    if (libRaw) {
      try {
        const parsed = JSON.parse(libRaw);
        parsed.forEach((item) => {
          // item: { id, name, src, type }
          // We intentionally skip persisted "public" entries here so the
          // on-disk manifest (/public/recordings/manifest.json) remains
          // authoritative and we avoid double-adding the same public file
          // (race between persisted decode and manifest decode can cause dupes).
          if (item.type === "public") return;

          // avoid duplicates by id or name+type
          const exists = libraryRef.current.find((l) => l.id === item.id || (l.name === item.name && l.type === item.type));
          if (exists) return;

          if (item.src) {
            decodeSrcToBuffer(item.src).then((buffer) => {
              setLibrary((prev) => {
                if (prev.find((p) => p.id === item.id || (p.name === item.name && p.type === item.type))) return prev;
                return [...prev, { ...item, buffer }];
              });
            }).catch(() => {
              // decode fail -> keep metadata without buffer
              setLibrary(prev => {
                if (prev.find(p => p.id === item.id || (p.name === item.name && p.type === item.type))) return prev;
                return [...prev, item];
              });
            });
          } else {
            setLibrary(prev => {
              if (prev.find(p => p.id === item.id || (p.name === item.name && p.type === item.type))) return prev;
              return [...prev, item];
            });
          }
        });
      } catch (e) {
        console.error("Failed to parse library:", e);
      }
    }

    // load placements from storage (without nodes)
    const psRaw = localStorage.getItem(PLACEMENTS_KEY);
    if (psRaw) {
      try {
        const parsed = JSON.parse(psRaw); // array
        setPlacements(parsed);
      } catch (e) {
        console.error("Failed to parse placements:", e);
      }
    }

    // load public recordings manifest (if exists)
    loadPublicManifest();

    return () => {
      // stop nodes and close context on unmount
      Object.values(nodesRef.current).forEach(stopPlacementNodes);
      audioCtxRef.current && audioCtxRef.current.close();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // whenever placements change, persist them (without nodes)
  useEffect(() => {
    try {
      localStorage.setItem(PLACEMENTS_KEY, JSON.stringify(placements));
    } catch (e) {}
  }, [placements]);

  // whenever library changes, persist metadata
  useEffect(() => {
    const metadata = library.map(({ id, name, src, type }) => ({ id, name, src, type }));
    try {
      localStorage.setItem(LIB_KEY, JSON.stringify(metadata));
    } catch (e) {}
  }, [library]);

  // whenever placements or library update, ensure nodes exist for each placement (if buffer available)
  useEffect(() => {
    placements.forEach((pl) => {
      if (nodesRef.current[pl.id]) {
        // already has nodes
        return;
      }
      const lib = libraryRef.current.find((l) => l.id === pl.libId);
      if (lib && lib.buffer) {
        // create nodes
        const nd = createPlacementNodes(pl, lib.buffer, pl.params || {}, audioCtxRef.current, masterGainRef.current, cols);
        nodesRef.current[pl.id] = nd;
        // ensure initial gain/pan reflect current cursor
        updatePlacementGainAndPan(pl, nd, cursorRef.current);
      }
    });
    // cleanup finished placements removed from state
    Object.keys(nodesRef.current).forEach((id) => {
      if (!placementsRef.current.find((p) => p.id === id)) {
        stopPlacementNodes(nodesRef.current[id]);
        delete nodesRef.current[id];
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [placements, library]);

  // Helpers --------------------------------------------------------

  function uid(prefix = "id") {
    return `${prefix}-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
  }

  async function decodeSrcToBuffer(src) {
    const ctx = audioCtxRef.current;
    if (src.startsWith("data:")) {
      // base64 data URL
      const res = await fetch(src);
      const ab = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      return buffer;
    } else {
      // regular URL (e.g. /recordings/file.mp3)
      const res = await fetch(src);
      const ab = await res.arrayBuffer();
      const buffer = await ctx.decodeAudioData(ab);
      return buffer;
    }
  }

  // Public manifest loader - expects /sound-garden/recordings/manifest.json to be an array of filenames
  async function loadPublicManifest() {
    try {
      const manifestRes = await fetch("/sound-garden/recordings/manifest.json");
      if (!manifestRes.ok) return;
      const files = await manifestRes.json();
      for (const fname of files) {
        const src = `/sound-garden/recordings/${fname}`;
        const id = `pub-${fname}`;
        // avoid duplicates by id or name+type
        try {
          const buffer = await decodeSrcToBuffer(src);
          setLibrary((prev) => {
            if (prev.find((p) => p.id === id || (p.name === fname && p.type === "public"))) return prev;
            return [...prev, { id, name: fname, src, type: "public", buffer }];
          });
        } catch (e) {
          console.warn("Failed to decode public recording", fname, e);
          setLibrary((prev) => {
            if (prev.find((p) => p.id === id || (p.name === fname && p.type === "public"))) return prev;
            return [...prev, { id, name: fname, src, type: "public" }];
          });
        }
      }
    } catch (e) {
      // no manifest or network error is OK
      // console.warn("No public manifest or failed to load:", e);
    }
  }

  // File upload handler (file -> dataURL -> buffer)
  function handleFileUpload(file) {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      try {
        const buffer = await decodeSrcToBuffer(dataUrl);
        const id = uid("upl");
        setLibrary((prev) => {
          // avoid adding duplicate uploads (same name+type or same src)
          if (prev.find((p) => (p.type === "upload" && p.name === file.name) || p.src === dataUrl)) return prev;
          return [...prev, { id, name: file.name, src: dataUrl, type: "upload", buffer }];
        });
      } catch (e) {
        alert("Failed to decode uploaded audio file. Ensure it is a supported format.");
      }
    };
    reader.readAsDataURL(file);
  }

  // region selection movement helper: add/trim path
  function handleRegionMovement(next) {
    const curRegion = regionRef.current.slice(); // copy
    const existingIdx = curRegion.findIndex((c) => c.x === next.x && c.y === next.y);
    if (existingIdx >= 0) {
      // backtrack => trim to that index
      const trimmed = curRegion.slice(0, existingIdx + 1);
      setRegion(trimmed);
    } else {
      setRegion([...curRegion, { x: next.x, y: next.y }]);
    }
    setLastRegionCell({ x: next.x, y: next.y });
  }

  function handleRegionMovementWithShift(curCursor, key, region, setRegion, lastCell, setLastCell) {
    const next = computeNextFromKey(curCursor, key);
    // If this is the first Shift+Arrow press, include the current cursor as the anchor
    if (!lastCell) {
      setRegion([{ x: curCursor.x, y: curCursor.y }, { x: next.x, y: next.y }]);
      setLastCell({ x: next.x, y: next.y });
      return next;
    }

    const existingIdx = region.findIndex(c => c.x === next.x && c.y === next.y);
    if (existingIdx >= 0) {
      // backtracking → trim path
      setRegion(region.slice(0, existingIdx + 1));
    } else {
      setRegion([...region, { x: next.x, y: next.y }]);
    }
    setLastCell({ x: next.x, y: next.y });
    return next;
  }

  function isArrowKey(k) {
    return ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(k);
  }

  function computeNextFromKey(cur, key) {
    if (!cur) return { x: Math.floor(cols / 2), y: 0 };
    let nx = cur.x;
    let ny = cur.y;
    if (key === "ArrowLeft") nx = Math.max(0, cur.x - 1);
    if (key === "ArrowRight") nx = Math.min(cols - 1, cur.x + 1);
    if (key === "ArrowUp") ny = Math.max(0, cur.y - 1);
    if (key === "ArrowDown") ny = Math.min(rows - 1, cur.y + 1);
    return { x: nx, y: ny };
  }

  // create placement region entry and start nodes
  function placeRecordingOnRegion(libItem, params = {}) {
    if (!region || region.length === 0) return;
    const newPlacement = {
      id: uid("pl"),
      cells: region.slice(),
      libId: libItem.id,
      params: { volume: params.volume ?? 1, radius: params.radius ?? defaultRadius, timing: 0, ...params },
    };
    setPlacements((prev) => {
      const next = [...prev, newPlacement];
      return next;
    });
    // clear region
    setRegion([]);
    setRegionActive(false);
    setLastRegionCell(null);
    setSearchOpen(false);
  }

  // Create audio nodes for a placement: returns { src, gain, panner }
  function createPlacementNodes(placement, buffer, params, audioCtx = audioCtxRef.current, masterGain = masterGainRef.current, gridWidth = cols) {
    if (!audioCtx || !buffer) return null;
    const src = audioCtx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;

    const gain = audioCtx.createGain();
    gain.gain.value = 0; // start silent

    const panner = audioCtx.createStereoPanner();
    // compute centroid-based pan
    const centroid = computeCentroid(placement.cells);
    const pan = centroidToPan(centroid, gridWidth);
    panner.pan.value = pan;

    // chain: src -> gain -> panner -> masterGain
    src.connect(gain);
    gain.connect(panner);
    panner.connect(masterGain);

    // start immediately (looping)
    try {
      src.start(audioCtx.currentTime + (params.timing ?? 0));
    } catch (e) {
      // some browsers require resume on user gesture; assumed already resumed elsewhere
    }

    return { src, gain, panner };
  }

  function stopPlacementNodes(nodes) {
    if (!nodes) return;
    try {
      const ctx = audioCtxRef.current;
      nodes.gain.gain.cancelScheduledValues(ctx.currentTime);
      nodes.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
      nodes.src.stop(ctx.currentTime + 0.05);
      nodes.src.disconnect();
      nodes.gain.disconnect();
      nodes.panner.disconnect();
    } catch (e) {}
  }

  function centroidToPan(centroid, gridWidth) {
    // centroid.x in [0 .. gridWidth-1] => pan -1 .. 1
    if (gridWidth <= 1) return 0;
    const norm = (centroid.x / (gridWidth - 1)) * 2 - 1;
    return Math.max(-1, Math.min(1, norm));
  }

  function computeCentroid(cells) {
    const sx = cells.reduce((s, c) => s + c.x, 0);
    const sy = cells.reduce((s, c) => s + c.y, 0);
    return { x: sx / cells.length, y: sy / cells.length };
  }

  // compute min distance from cursor to the placement's cells
  function minDistanceToPlacement(cursorPos, placement) {
    if (!cursorPos) return Infinity;
    let md = Infinity;
    placement.cells.forEach((c) => {
      const dx = c.x - cursorPos.x;
      const dy = c.y - cursorPos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < md) md = d;
    });
    return md;
  }

  // compute gain (linear) 1 at 0 -> 0 at >= radius
  function computeGainFromDistance(d, radius, baseVol = 1) {
    if (d > radius) return 0;
    const g = (1 - d / radius) * baseVol;
    return Math.max(0, Math.min(1.0 * baseVol, g));
  }

  // update gains & pans for all running placement nodes when cursor moves
  function updatePlacementGainAndPan(placement, nodes, cursorPos) {
    if (!nodes) return;
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    const d = minDistanceToPlacement(cursorPos, placement);
    const radius = placement.params?.radius ?? defaultRadius;
    const target = computeGainFromDistance(d, radius, placement.params?.volume ?? 1.0);
    try {
      nodes.gain.gain.cancelScheduledValues(now);
      nodes.gain.gain.linearRampToValueAtTime(target, now + 0.06);
    } catch (e) {}

    // panning remains based on centroid (no change unless region mutated)
    // If you want dynamic panning based on cursor position, you can compute pan here.
    try {
      const centroid = computeCentroid(placement.cells);
      const pan = centroidToPan(centroid, cols);
      nodes.panner.pan.cancelScheduledValues(now);
      nodes.panner.pan.linearRampToValueAtTime(pan, now + 0.06);
    } catch (e) {}
  }

  // Event handlers ------------------------------------------------

  // global key handling for navigation, region selection, placing, deleting, editing
  useEffect(() => {
    function onKeyDown(e) {
      const key = e.key;

      // top-level: add file picker (1), etc. (you can wire UI) - omitted for brevity

      // If region active and arrow + shift: expand/trim region
    //   if (e.shiftKey && isArrowKey(key)) {
    //     e.preventDefault();
    //     // ensure cursor exists
    //     const cur = cursorRef.current || { x: Math.floor(cols / 2), y: 0 };
    //     const next = computeNextFromKey(cur, key);
    //     setCursor(next);
    //     handleRegionMovement(next);
    //     setRegionActive(true);
    //     return;
    //   }
        // TODO: just shift;
      if (e.shiftKey && isArrowKey(key)) {
        e.preventDefault();
        // ensure cursor exists
        const cur = cursorRef.current || { x: Math.floor(cols / 2), y: 0 };
        const next = handleRegionMovementWithShift(cur, key, regionRef.current, setRegion, lastRegionCell, setLastRegionCell);
        setCursor(next);
        setRegionActive(true);
        return;
      }

      // movement without shift initializes cursor if needed
      if (isArrowKey(key) || ["w", "a", "s", "d"].includes(key)) {
        e.preventDefault();
        const cur = cursorRef.current || { x: Math.floor(cols / 2), y: 0 };
        // map WASD
        let realKey = key;
        if (key === "w") realKey = "ArrowUp";
        if (key === "s") realKey = "ArrowDown";
        if (key === "a") realKey = "ArrowLeft";
        if (key === "d") realKey = "ArrowRight";
        const next = computeNextFromKey(cur, realKey);
        setCursor(next);
        // if moving without shift, cancel region selection
        if (regionActive) {
          setRegionActive(false);
          setRegion([]);
          setLastRegionCell(null);
        }
        // update gains
        Object.entries(nodesRef.current).forEach(([id, nd]) => {
          const placement = placementsRef.current.find((p) => p.id === id);
          if (placement) updatePlacementGainAndPan(placement, nd, next);
        });
        return;
      }

      // Backspace/Delete: delete placement at cursor if any
      if (key === "Backspace" || key === "Delete") {
        if (cursorRef.current) {
          // find placement that contains this cell
          const found = placementsRef.current.find((p) => p.cells.some((c) => c.x === cursorRef.current.x && c.y === cursorRef.current.y));
          if (found) {
            e.preventDefault();
            // remove and stop nodes
            setPlacements((prev) => prev.filter((p) => p.id !== found.id));
            if (nodesRef.current[found.id]) {
              stopPlacementNodes(nodesRef.current[found.id]);
              delete nodesRef.current[found.id];
            }
          }
        }
        return;
      }

      // If alphanumeric pressed:
      if (/^[a-z0-9]$/i.test(key)) {
        // if regionActive => open search with initial char and on Enter place region-recording
        if (regionActive && regionRef.current.length > 0) {
          e.preventDefault();
          setSearchQuery(key);
          setSearchHighlightIdx(0);
          setSearchOpen(true);
          return;
        }

        // Otherwise, if cursor on a cell and not regionActive, treat as search for that single cell (legacy behavior)
        if (cursorRef.current) {
          e.preventDefault();
          setRegion([]); // no region
          setRegionActive(false);
          // open search but will place on single cell as a 1-cell region
          setSearchQuery(key);
          setSearchHighlightIdx(0);
          setSearchOpen(true);
          return;
        }
      }

      // Escape to clear search/region
      if (key === "Escape") {
        setSearchOpen(false);
        setRegion([]);
        setRegionActive(false);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [regionActive, cols, rows]);

  // handle search navigation/selection keys while dropdown is open
  useEffect(() => {
    if (!searchOpen) return;
    function onSearchKey(e) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSearchHighlightIdx((i) => i + 1);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSearchHighlightIdx((i) => Math.max(0, i - 1));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const list = filteredLibrary();
        const item = list[searchHighlightIdx] || list[0];
        if (item) {
          // If regionActive, place region; otherwise place single-cell region at cursor
          if (regionActive && regionRef.current.length > 0) {
            placeRecordingOnRegion(item);
          } else if (cursorRef.current) {
            // create a placement for single cell
            const newPlacement = {
              id: uid("pl"),
              cells: [{ x: cursorRef.current.x, y: cursorRef.current.y }],
              libId: item.id,
              params: { volume: 1, radius: defaultRadius, timing: 0 },
            };
            setPlacements((prev) => [...prev, newPlacement]);
            setSearchOpen(false);
          }
        }
      } else if (e.key === "Escape") {
        setSearchOpen(false);
      }
    }
    window.addEventListener("keydown", onSearchKey);
    return () => window.removeEventListener("keydown", onSearchKey);
  }, [searchOpen, searchHighlightIdx, regionActive, defaultRadius]);

  // Compute filtered library based on searchQuery
  function filteredLibrary() {
    const q = searchQuery.toLowerCase();
    return library.filter((l) => l.name.toLowerCase().includes(q));
  }

    // utility: add uploaded file via input
  function onFileInputChange(e) {
    const f = e.target.files?.[0];
    if (f) handleFileUpload(f);
    e.target.value = null;
  }

  // editor save
  function saveEditor(params) {
    if (!editorCell) return;
    const key = `${editorCell.x},${editorCell.y}`;
    setPlacements(prev => ({ ...prev, [key]: { ...prev[key], params } }));
    refreshPlacementGains(cursorRef.current);
    setEditorCell(null);
  }

  // UI rendering helpers ------------------------------------------

  function renderCell(x, y) {
    const key = `${x},${y}`;
    const has = placements.some((p) => p.cells.some((c) => c.x === x && c.y === y));
    const isCursor = cursor && cursor.x === x && cursor.y === y;
    const isInRegion = region.some((c) => c.x === x && c.y === y);
    return (
      <div
        key={key}
        role="gridcell"
        aria-label={`Cell ${x + 1}, ${y + 1}${has ? ", has recording" : ""}`}
        className={`relative w-12 h-12 border border-gray-300 flex items-center justify-center ${isInRegion ? "bg-blue-50" : "bg-white"}`}
      >
        {/* cursor outline */}
        {isCursor && <div className="absolute inset-0 border-2 border-black pointer-events-none" aria-hidden />}
        {/* placed dot */}
        {has && <div className="w-3 h-3 rounded-full bg-emerald-600" aria-hidden />}
      </div>
    );
  }

  // Note: region outlines are rendered inline inside the grid overlay below
  // to ensure they share the same grid coordinate space as the cells. The
  // old `renderRegionOutline` helper was removed to avoid accidentally
  // rendering outlines from a different positioning context which could
  // produce mirrored or offset outlines.

  // Utility: find placement that contains cell
  function findPlacementAtCell(x, y) {
    return placements.find((p) => p.cells.some((c) => c.x === x && c.y === y));
  }

  // UI actions ----------------------------------------------------

  function handleFileInputChange(e) {
    const f = e.target.files?.[0];
    if (f) {
      handleFileUpload(f);
    }
    e.target.value = null;
  }

  function handlePlaceFromList(item) {
    // if regionActive -> place on region
    if (regionActive && region.length > 0) {
      placeRecordingOnRegion(item);
      return;
    }
    // if cursor exists -> single-cell placement
    if (cursor) {
      const newPlacement = {
        id: uid("pl"),
        cells: [{ x: cursor.x, y: cursor.y }],
        libId: item.id,
        params: { volume: 1, radius: defaultRadius, timing: 0 },
      };
      setPlacements((prev) => [...prev, newPlacement]);
      setSearchOpen(false);
    } else {
      alert("Place the cursor with arrow keys first");
    }
  }

  // When cursor is set (including via keyboard), update gains for running placements
  useEffect(() => {
    if (!cursor) return;
    Object.entries(nodesRef.current).forEach(([id, nd]) => {
      const placement = placementsRef.current.find((p) => p.id === id);
      if (placement) updatePlacementGainAndPan(placement, nd, cursor);
    });
  }, [cursor]);

  // JSX -----------------------------------------------------------

  return (
    <div className="p-4 font-sans">
      {/* <div className="flex items-center gap-4 mb-4">
        <div className="text-sm font-medium">Soundscape — Grid</div>
        <div className="flex gap-3">
          <label className="px-3 py-1 rounded border cursor-pointer">
            Add recording
            <input id="file-input" type="file" accept="audio/*" onChange={handleFileInputChange} className="hidden" />
          </label>
        </div>
        <div className="ml-auto text-xs text-gray-500">Use Arrow keys (or WASD) to move. Hold Shift + Arrow to select a path. Type alphanumeric to choose recording. Enter to place.</div>
      </div> */}
      <div className="flex items-center gap-4 mb-4">
        <div className="text-sm font-medium">Top Menu (keyboard shortcuts)</div>
        <div className="flex gap-3">
          <label className="px-3 py-1 rounded border cursor-pointer">
            1 — Add recording
            <input id="file-input" type="file" accept="audio/*" onChange={onFileInputChange} className="hidden" />
          </label>
          {/* <button className="px-3 py-1 rounded border" onClick={() => setMuted(m => !m)}>2 — Toggle mute ({muted ? 'Muted' : 'Unmuted'})</button>
          <button className="px-3 py-1 rounded border" onClick={() => setBlackout(b => !b)}>3 — Toggle blackout ({blackout ? 'On' : 'Off'})</button> */}
        </div>
        <div className="ml-auto text-xs text-gray-500">Arrows/WASD move. Alphanumeric opens library search. Enter places. Backspace/Delete removes. 'e' edits.</div>
      </div>

      <div className="relative">
        {/* Grid container with CSS grid so region outlines can use gridColumn/gridRow */}
        <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 48px)` }} className="relative">
          {Array.from({ length: rows }).flatMap((_, y) =>
            Array.from({ length: cols }).map((_, x) => renderCell(x, y))
          )}
          {/* overlays go after cells so they appear on top */}
          <div style={{ gridColumn: `1 / ${cols + 1}`, gridRow: `1 / ${rows + 1}`, position: "absolute", inset: 0, pointerEvents: "none" }}>
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${cols}, 48px)` }}>
              {regionActive && region.map((c) => (
                // <div key={`outline-${c.x}-${c.y}`} style={{ gridColumn: c.x + 1, gridRow: c.y + 1, width: 48, height: 48, boxSizing: "border-box", border: "2px solid rgba(60,130,255,0.9)", borderRadius: 4, pointerEvents: "none", animation: "pulse 1s infinite" }} />
                <div key={`outline-${c.x}-${c.y}`} style={{ gridColumn: c.x + 1, gridRow: c.y + 1, width: 48, height: 48, boxSizing: "border-box"}} />
                // TODO: check
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Library & Placements panel */}
      <div className="mt-4 flex gap-6">
        <div className="w-80">
          <div className="text-sm font-semibold mb-2">Library</div>
          <ul className="max-h-48 overflow-auto border rounded p-2 text-sm">
            {library.length === 0 && <li className="text-gray-500">No recordings yet — upload or place files in public/recordings with manifest.json</li>}
            {library.map((item) => (
              <li key={item.id} className="py-1 flex justify-between items-center">
                <div className="truncate">{item.name}</div>
                <div className="flex gap-2">
                  <button className="px-2 py-0.5 border rounded text-xs" onClick={() => handlePlaceFromList(item)}>Place</button>
                  <button className="px-2 py-0.5 border rounded text-xs" onClick={() => {
                    // delete library item (also remove any placements referencing it)
                    setPlacements(prev => prev.filter(p => p.libId !== item.id));
                    setLibrary(prev => prev.filter(l => l.id !== item.id));
                    if (item.type === "upload") {
                      // uploaded dataURL might be large but we'll just remove the entry
                    }
                  }}>Delete</button>
                </div>
              </li>
            ))}
          </ul>
        </div>

        <div className="w-80">
          <div className="text-sm font-semibold mb-2">Placements (grouped by region)</div>
          <ul className="max-h-48 overflow-auto border rounded p-2 text-sm">
            {placements.length === 0 && <li className="text-gray-500">No placements</li>}
            {placements.map((p) => (
              <li key={p.id} className="py-1 flex justify-between items-center">
                <div>
                  <div className="font-medium text-xs">{p.id}</div>
                  <div className="text-xs text-gray-400">cells: {p.cells.map(c => `(${c.x},${c.y})`).join(" ")}</div>
                  <div className="text-xs text-gray-400">lib: {library.find(l => l.id === p.libId)?.name || p.libId}</div>
                </div>
                <div className="flex flex-col gap-1">
                  <button className="px-2 py-0.5 border rounded text-xs" onClick={() => {
                    // remove placement
                    setPlacements(prev => prev.filter(x => x.id !== p.id));
                    if (nodesRef.current[p.id]) {
                      stopPlacementNodes(nodesRef.current[p.id]);
                      delete nodesRef.current[p.id];
                    }
                  }}>Remove</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </div>

      {/* Search Dropdown */}
      {searchOpen && (
        <div className="fixed left-1/2 transform -translate-x-1/2 top-32 z-50 w-96 bg-white border rounded shadow-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm">Select recording for region</div>
            <div className="ml-auto text-xs text-gray-400">Type to filter — Enter to choose — Esc to cancel</div>
          </div>
          <input
            autoFocus
            value={searchQuery}
            onChange={(e) => { setSearchQuery(e.target.value); setSearchHighlightIdx(0); }}
            className="w-full border rounded p-2 mb-2"
            aria-label="Search recordings"
          />
          <ul className="max-h-48 overflow-auto">
            {filteredLibrary().map((item, i) => (
              <li key={item.id}
                className={`p-2 rounded cursor-pointer ${i === searchHighlightIdx ? 'bg-gray-100' : ''}`}
                onMouseEnter={() => setSearchHighlightIdx(i)}
                onClick={() => handlePlaceFromList(item)}
              >
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-gray-500">{item.type || 'file'}</div>
              </li>
            ))}
            {filteredLibrary().length === 0 && <li className="p-2 text-gray-500">No results</li>}
          </ul>
        </div>
      )}

      {/* small style for pulse (Tailwind doesn't provide animate-pulse for custom inline boxes) */}
      <style>{`
        @keyframes pulse {
          0% { opacity: 1; }
          50% { opacity: 0.4; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}