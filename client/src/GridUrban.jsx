import React, { useEffect, useRef, useState } from "react";

// Enhanced single-file React + Tailwind prototype
// Features added over the previous version:
//  - Replace synth recordings with uploaded audio files (file picker + decode)
//  - Persist library and placements to localStorage (audio stored as base64 data URLs)
//  - Spatial audio improvements: StereoPannerNode for left/right panning based on cell X,
//    smooth gain ramps (linearRampToValueAtTime) for crossfades when cursor moves
// Default grid: 8x8

export default function SoundscapePrototype({ cols = 8, rows = 8, defaultRadius = 3 }) {
  // UI state
  const [cursor, setCursor] = useState(null); // {x,y} or null
  const [blackout, setBlackout] = useState(false);
  const [muted, setMuted] = useState(false);

  // Library: { id, name, dataUrl(Base64), audioBuffer (in memory) }
  const [library, setLibrary] = useState([]);

  // placements: key = "x,y" -> { x,y, libId, params, nodes }
  const [placements, setPlacements] = useState({});

  // editor / search states
  const [editorCell, setEditorCell] = useState(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlightIdx, setSearchHighlightIdx] = useState(0);

  // audio
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  // localStorage keys
  const LIB_KEY = "ss_library_v1";
  const PLACEMENTS_KEY = "ss_placements_v1";

  // initialize audio context and restore persisted state
  useEffect(() => {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    audioCtxRef.current = new Ctx();
    masterGainRef.current = audioCtxRef.current.createGain();
    masterGainRef.current.gain.value = muted ? 0 : 1;
    masterGainRef.current.connect(audioCtxRef.current.destination);

    // load library & placements from localStorage
    const libRaw = localStorage.getItem(LIB_KEY);
    if (libRaw) {
      try {
        const parsed = JSON.parse(libRaw);
        // parsed: [{id,name,dataUrl}]
        // decode each dataUrl into AudioBuffer asynchronously
        parsed.forEach((item) => {
          if (item.dataUrl) {
            dataUrlToAudioBuffer(item.dataUrl).then((buffer) => {
              setLibrary(prev => {
                // avoid duplicates
                if (prev.find(p => p.id === item.id)) return prev;
                return [...prev, { id: item.id, name: item.name, dataUrl: item.dataUrl, buffer }];
              });
            }).catch(() => {
              // skip if decode fails
            });
          }
        });
      } catch (e) {}
    }

    const placementsRaw = localStorage.getItem(PLACEMENTS_KEY);
    if (placementsRaw) {
      try {
        const parsed = JSON.parse(placementsRaw); // object keyed by 'x,y' -> { x,y,libId,params }
        setPlacements(parsed);
        // we will start audio nodes for those placements once the corresponding lib buffer is loaded
      } catch (e) {}
    }

    return () => {
      // stop all nodes and close ctx on unmount
      Object.values(placementsRef.current).forEach(p => stopPlacementSoundSync(p));
      audioCtxRef.current && audioCtxRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = muted ? 0 : 1;
    localStorage.setItem(PLACEMENTS_KEY, JSON.stringify(stripPlacementNodes(placements)));
  }, [muted]);

  useEffect(() => {
    // persist library metadata and dataUrl
    const toSave = library.map(({ id, name, dataUrl }) => ({ id, name, dataUrl }));
    try { localStorage.setItem(LIB_KEY, JSON.stringify(toSave)); } catch (e) {}
  }, [library]);

  useEffect(() => {
    // whenever placements state changes, ensure audio nodes exist for each placement that has a decoded buffer
    Object.entries(placements).forEach(([key, pl]) => {
      if (pl.nodes) return; // already has nodes
      const lib = library.find(l => l.id === pl.libId);
      if (lib && lib.buffer) {
        const nodes = startPlacementSoundNodes(pl.x, pl.y, lib.buffer, pl.params);
        setPlacements(prev => ({ ...prev, [key]: { ...prev[key], nodes } }));
      }
    });
    // update gains per cursor
    refreshPlacementGains(cursorRef.current);
    // persist placements without nodes
    localStorage.setItem(PLACEMENTS_KEY, JSON.stringify(stripPlacementNodes(placements)));
  }, [placements, library]);

  // helper to remove nodes before persisting
  function stripPlacementNodes(pls) {
    const out = {};
    Object.entries(pls).forEach(([k, v]) => {
      const copy = { ...v };
      delete copy.nodes;
      out[k] = copy;
    });
    return out;
  }

  // convert dataUrl to AudioBuffer
  function dataUrlToAudioBuffer(dataUrl) {
    const ctx = audioCtxRef.current;
    return fetch(dataUrl)
      .then(r => r.arrayBuffer())
      .then(buf => ctx.decodeAudioData(buf));
  }

  // convert File -> dataUrl (base64) and decode
  function handleFileUpload(file) {
    const reader = new FileReader();
    reader.onload = async (ev) => {
      const dataUrl = ev.target.result;
      try {
        const buffer = await dataUrlToAudioBuffer(dataUrl);
        const id = `lib-${Date.now()}`;
        const name = file.name;
        setLibrary(prev => [...prev, { id, name, dataUrl, buffer }]);
      } catch (e) {
        alert('Failed to decode audio file. Make sure it is an MP3/WAV/AAC supported by your browser.');
      }
    };
    reader.readAsDataURL(file);
  }

  // start audio nodes for placement: returns { source, gain, panner }
  function startPlacementSoundNodes(x, y, audioBuffer, params = {}) {
    const ctx = audioCtxRef.current;
    if (!ctx || !audioBuffer) return null;

    // create source (AudioBufferSourceNode) and set loop
    const src = ctx.createBufferSource();
    src.buffer = audioBuffer;
    src.loop = true;

    const gain = ctx.createGain();
    gain.gain.value = 0; // start silent

    const panner = ctx.createStereoPanner();
    panner.pan.value = computePanForX(x);

    // chain: src -> gain -> panner -> master
    src.connect(gain);
    gain.connect(panner);
    panner.connect(masterGainRef.current);

    const now = ctx.currentTime;
    try { src.start(now + (params.timing ?? 0)); } catch (e) {}

    return { src, gain, panner };
  }

  function stopPlacementSoundSync(pl) {
    if (!pl || !pl.nodes) return;
    const ctx = audioCtxRef.current;
    try {
      // ramp down quickly
      pl.nodes.gain.gain.cancelScheduledValues(ctx.currentTime);
      pl.nodes.gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.03);
      // stop source after brief fade
      pl.nodes.src.stop(ctx.currentTime + 0.05);
      pl.nodes.src.disconnect();
      pl.nodes.gain.disconnect();
      pl.nodes.panner.disconnect();
    } catch (e) {}
  }

  // remove placement and stop audio
  function stopPlacementSound(key) {
    const pl = placementsRef.current[key];
    if (!pl) return;
    stopPlacementSoundSync(pl);
    setPlacements(prev => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }

  // compute stereo pan for given x: -1..1 based on center
  function computePanForX(x) {
    const center = (cols - 1) / 2;
    if (cols === 1) return 0;
    const pan = (x - center) / center;
    return Math.max(-1, Math.min(1, pan));
  }

  // distance and gain calc with linear decay
  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function computeGainForPlacement(placement, cursorPos) {
    if (!cursorPos) return 0;
    const d = distance({ x: placement.x, y: placement.y }, cursorPos);
    const radius = placement.params?.radius ?? defaultRadius;
    if (d > radius) return 0;
    const base = 1 - d / radius; // linear in [0,1]
    return base * (placement.params?.volume ?? 1);
  }

  // smoothly refresh all placement gains & pans when cursor moves
  function refreshPlacementGains(cursorPos) {
    const ctx = audioCtxRef.current;
    const now = ctx.currentTime;
    Object.entries(placementsRef.current).forEach(([key, pl]) => {
      if (!pl.nodes) return;
      const targetGain = computeGainForPlacement(pl, cursorPos);
      // smooth ramp for crossfade
      try {
        pl.nodes.gain.gain.cancelScheduledValues(now);
        pl.nodes.gain.gain.linearRampToValueAtTime(targetGain, now + 0.08);
      } catch (e) {}

      // update panner based on actual pan from x and optional angularRange etc.
      try {
        const targetPan = computePanForX(pl.x);
        pl.nodes.panner.pan.cancelScheduledValues(now);
        pl.nodes.panner.pan.linearRampToValueAtTime(targetPan, now + 0.08);
      } catch (e) {}
    });
  }

  // keyboard handling
  useEffect(() => {
    function onKeyDown(e) {
      const key = e.key;

      // top menu
      if (key === "1") { e.preventDefault(); document.getElementById('file-input')?.click(); return; }
      if (key === "2") { e.preventDefault(); setMuted(m => !m); return; }
      if (key === "3") { e.preventDefault(); setBlackout(b => !b); return; }

      if (searchOpen) {
        if (key === "ArrowDown") { e.preventDefault(); setSearchHighlightIdx(i => i + 1); return; }
        if (key === "ArrowUp") { e.preventDefault(); setSearchHighlightIdx(i => Math.max(0, i - 1)); return; }
        if (key === "Enter") {
          e.preventDefault(); const list = filteredLibrary(); const item = list[searchHighlightIdx] || list[0]; if (item && cursorRef.current) selectLibraryItemForCursor(item); return;
        }
        if (key === "Escape") { setSearchOpen(false); return; }
      }

      const movementKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "d", "w", "s"];
      if (movementKeys.includes(key)) {
        e.preventDefault();
        if (!cursorRef.current) {
          const startX = Math.floor(cols / 2);
          const startY = 0;
          setCursor({ x: startX, y: startY });
          setTimeout(() => refreshPlacementGains({ x: startX, y: startY }), 10);
          return;
        }
        const cur = cursorRef.current;
        let nx = cur.x, ny = cur.y;
        if (key === "ArrowLeft" || key === "a") nx = Math.max(0, cur.x - 1);
        if (key === "ArrowRight" || key === "d") nx = Math.min(cols - 1, cur.x + 1);
        if (key === "ArrowUp" || key === "w") ny = Math.max(0, cur.y - 1);
        if (key === "ArrowDown" || key === "s") ny = Math.min(rows - 1, cur.y + 1);
        setCursor({ x: nx, y: ny });
        refreshPlacementGains({ x: nx, y: ny });
        return;
      }

      if (key === "Backspace" || key === "Delete") {
        if (cursorRef.current) {
          const k = `${cursorRef.current.x},${cursorRef.current.y}`;
          if (placementsRef.current[k]) { e.preventDefault(); stopPlacementSound(k); return; }
        }
      }

      if (key === "e") {
        if (cursorRef.current) {
          const k = `${cursorRef.current.x},${cursorRef.current.y}`;
          if (placementsRef.current[k]) { e.preventDefault(); setEditorCell({ x: cursorRef.current.x, y: cursorRef.current.y }); return; }
        }
      }

      if (/^[a-z0-9]$/i.test(key)) {
        if (cursorRef.current) {
          e.preventDefault(); setSearchQuery(key); setSearchOpen(true); setSearchHighlightIdx(0); return;
        }
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [searchOpen, searchHighlightIdx, library, placements]);

  function filteredLibrary() {
    const q = searchQuery.toLowerCase();
    return library.filter(item => item.name.toLowerCase().includes(q));
  }

  function selectLibraryItemForCursor(item) {
    const cur = cursorRef.current;
    if (!cur) return;
    const key = `${cur.x},${cur.y}`;
    const params = { volume: 1, radius: defaultRadius, angularRange: 360, proximityTriggers: true, timing: 0 };
    setPlacements(prev => ({ ...prev, [key]: { x: cur.x, y: cur.y, libId: item.id, params } }));
    setSearchOpen(false);
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

  // render cell
  function renderCell(x, y) {
    const key = `${x},${y}`;
    const has = !!placements[key];
    return (
      <div key={key} role="gridcell" aria-label={`Cell ${x+1},${y+1}${has ? ', has recording' : ''}`} className={`relative w-12 h-12 border border-gray-300 flex items-center justify-center ${blackout ? 'bg-black' : 'bg-white'}`}>
        {cursor && cursor.x === x && cursor.y === y && <div className="absolute inset-0 border-2 border-black pointer-events-none" aria-hidden />}
        {has && <div className="w-3 h-3 rounded-full bg-emerald-600" aria-hidden />}
      </div>
    );
  }

  // stop all and remove
  function clearAllPlacements() {
    Object.entries(placementsRef.current).forEach(([k, pl]) => stopPlacementSoundSync(pl));
    setPlacements({});
    localStorage.removeItem(PLACEMENTS_KEY);
  }

  return (
    <div className="p-4 font-sans">
      <div className="flex items-center gap-4 mb-4">
        <div className="text-sm font-medium">Top Menu (keyboard shortcuts)</div>
        <div className="flex gap-3">
          <label className="px-3 py-1 rounded border cursor-pointer">
            1 — Add recording
            <input id="file-input" type="file" accept="audio/*" onChange={onFileInputChange} className="hidden" />
          </label>
          <button className="px-3 py-1 rounded border" onClick={() => setMuted(m => !m)}>2 — Toggle mute ({muted ? 'Muted' : 'Unmuted'})</button>
          <button className="px-3 py-1 rounded border" onClick={() => setBlackout(b => !b)}>3 — Toggle blackout ({blackout ? 'On' : 'Off'})</button>
        </div>
        <div className="ml-auto text-xs text-gray-500">Arrows/WASD move. Alphanumeric opens library search. Enter places. Backspace/Delete removes. 'e' edits.</div>
      </div>

      <div className="flex gap-6">
        <div>
          <div role="grid" aria-label="Soundscape grid">
            <div style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 48px)` }}>
              {Array.from({ length: rows }).flatMap((_, y) => Array.from({ length: cols }).map((_, x) => renderCell(x, y)))}
            </div>
          </div>
        </div>

        <div className="w-80">
          <div className="mb-4">
            <div className="text-sm font-semibold">Library</div>
            <ul className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm">
              {library.length === 0 && <li className="text-gray-500">No recordings yet — press 1 or use the file picker</li>}
              {library.map(item => (
                <li key={item.id} className="py-1 flex justify-between items-center">
                  <div className="truncate">{item.name}</div>
                  <div className="flex gap-2">
                    <button className="px-2 py-0.5 border rounded text-xs" onClick={() => {
                      if (!cursor) return alert('Place the cursor with arrow keys first');
                      selectLibraryItemForCursor(item);
                    }}>Place</button>
                    <button className="px-2 py-0.5 border rounded text-xs" onClick={() => setLibrary(prev => prev.filter(p => p.id !== item.id))}>Delete</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-sm font-semibold">Placements</div>
            <ul className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm">
              {Object.keys(placements).length === 0 && <li className="text-gray-500">No placements</li>}
              {Object.entries(placements).map(([k, pl]) => (
                <li key={k} className="py-1 flex justify-between">
                  <div>{k} — {library.find(l=>l.id===pl.libId)?.name || pl.libId}</div>
                  <div className="flex gap-2">
                    <button className="text-xs px-2 py-0.5 border rounded" onClick={() => stopPlacementSound(k)}>Remove</button>
                    <button className="text-xs px-2 py-0.5 border rounded" onClick={() => setEditorCell({ x: pl.x, y: pl.y })}>Edit</button>
                  </div>
                </li>
              ))}
            </ul>

            <div className="mt-3 flex gap-2">
              <button className="px-3 py-1 border rounded" onClick={() => { if (confirm('Clear all placements?')) clearAllPlacements(); }}>Clear all</button>
            </div>
          </div>
        </div>
      </div>

      {/* Search dropdown */}
      {searchOpen && (
        <div className="fixed left-1/2 transform -translate-x-1/2 top-24 z-50 w-96 bg-white border rounded shadow-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm">Select recording for cell</div>
            <div className="ml-auto text-xs text-gray-400">Type to filter — Enter to choose — Esc to cancel</div>
          </div>
          <input autoFocus value={searchQuery} onChange={(e)=>{ setSearchQuery(e.target.value); setSearchHighlightIdx(0); }} className="w-full border rounded p-2 mb-2" aria-label="Search recordings" />
          <ul className="max-h-48 overflow-auto">
            {filteredLibrary().map((item, i) => (
              <li key={item.id} className={`p-2 rounded cursor-pointer ${i === searchHighlightIdx ? 'bg-gray-100' : ''}`} onMouseEnter={()=>setSearchHighlightIdx(i)} onClick={()=>selectLibraryItemForCursor(item)}>
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-gray-500">{item.dataUrl ? 'file' : '—'}</div>
              </li>
            ))}
            {filteredLibrary().length === 0 && <li className="p-2 text-gray-500">No results</li>}
          </ul>
        </div>
      )}

      {/* Editor panel */}
      {editorCell && (() => {
        const key = `${editorCell.x},${editorCell.y}`;
        const pl = placements[key];
        const params = { ...pl.params };
        let vol = params.volume ?? 1;
        let radius = params.radius ?? defaultRadius;
        let angularRange = params.angularRange ?? 360;
        let proximityTriggers = params.proximityTriggers ?? true;
        let timing = params.timing ?? 0;

        return (
          <div key={key} className="fixed right-6 top-24 w-96 bg-white border rounded shadow-lg p-4 z-40">
            <div className="flex items-center justify-between">
              <div className="font-semibold">Edit cell {editorCell.x},{editorCell.y}</div>
              <div className="text-xs text-gray-500">{library.find(l=>l.id===pl.libId)?.name || '—'}</div>
            </div>
            <div className="mt-3 space-y-3 text-sm">
              <div>
                <label className="block text-xs text-gray-600">Volume</label>
                <input type="range" min={0} max={2} step={0.01} defaultValue={vol} onChange={(e)=>{ vol = parseFloat(e.target.value); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-600">Radius</label>
                <input type="range" min={0.5} max={10} step={0.1} defaultValue={radius} onChange={(e)=>{ radius = parseFloat(e.target.value); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-600">Angular range (°)</label>
                <input type="number" defaultValue={angularRange} onChange={(e)=>{ angularRange = parseFloat(e.target.value); }} className="w-full border rounded p-1" />
              </div>
              <div>
                <label className="block text-xs text-gray-600">Proximity triggers</label>
                <select defaultValue={proximityTriggers ? 'on' : 'off'} onChange={(e)=>{ proximityTriggers = e.target.value === 'on'; }} className="w-full border rounded p-1">
                  <option value="on">On</option>
                  <option value="off">Off</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-600">Timing offset (sec)</label>
                <input type="number" defaultValue={timing} onChange={(e)=>{ timing = parseFloat(e.target.value); }} className="w-full border rounded p-1" />
              </div>

              <div className="flex gap-2 justify-end">
                <button className="px-3 py-1 border rounded" onClick={()=>setEditorCell(null)}>Cancel</button>
                <button className="px-3 py-1 bg-blue-600 text-white rounded" onClick={()=>saveEditor({ volume: vol, radius, angularRange, proximityTriggers, timing })}>Save</button>
              </div>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

/* Notes on limitations & behaviour
 - Persistence stores audio files as base64 data URLs inside localStorage (works for small files; very large files may exceed storage quota). For production, moving to IndexedDB/Blob storage is recommended.
 - AudioBufferSourceNodes are created per placement and looped. Stopping them removes the node; re-placing the same library item will create a new source.
 - Spatialization is simple stereo panning based on X coordinate. More advanced 3D audio can be added with PannerNode.
 - Gain changes and pan changes are smoothed with linear ramping to achieve crossfade-like transitions.
*/