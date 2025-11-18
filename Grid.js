import React, { useEffect, useRef, useState } from "react";

// Single-file React + Tailwind prototype for keyboard-accessible soundscape grid
// Default grid: 8x8
// - Cursor starts OFF-SCREEN (null). On first navigation keypress it is initialized to {x: floor(cols/2), y:0}
// - Move with Arrow keys or WASD (W / ArrowUp = forward / up, S / ArrowDown = back / down, A / ArrowLeft, D / ArrowRight)
// - Library uses synthesized tones (oscillators) so no external assets required for this prototype
// - Press any alphanumeric key while a cursor is on a cell to open searchable dropdown. Press Enter to place a recording.
// - Placed recordings create a dot and start playing. Gain is computed as linear decay from distance 0..radius (default 3)
// - Backspace/Delete removes a placed recording under cursor
// - Press 'e' on a cell with a recording to open a side panel with editable params
// - Top menu with labeled controls: 1=Add recording to lib, 2=Toggle mute, 3=Toggle blackout

export default function Grid({ cols = 8, rows = 8, defaultRadius = 3 }) {
  const [cursor, setCursor] = useState(null); // {x,y} or null
  const [blackout, setBlackout] = useState(false);
  const [muted, setMuted] = useState(false);

  // Library of recordings (synth tones for the prototype)
  const [library, setLibrary] = useState(() => {
    // simple octave-ish set
    const base = ["C4", "D4", "E4", "F4", "G4", "A4", "B4", "C5"];
    const freqs = [261.63, 293.66, 329.63, 349.23, 392.0, 440.0, 493.88, 523.25];
    return base.map((n, i) => ({ id: `lib-${i}`, name: n, type: "synth", freq: freqs[i] }));
  });

  // placements map: key = `${x},${y}` -> { libId, params, audioNodes... }
  const [placements, setPlacements] = useState({});

  // editor panel state
  const [editorCell, setEditorCell] = useState(null); // {x,y}

  // search/dropdown state
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchHighlightIdx, setSearchHighlightIdx] = useState(0);
  const [searchInitiatorKey, setSearchInitiatorKey] = useState(null);

  // audio context and master nodes
  const audioCtxRef = useRef(null);
  const masterGainRef = useRef(null);
  const placementsRef = useRef(placements);
  placementsRef.current = placements;
  const cursorRef = useRef(cursor);
  cursorRef.current = cursor;

  useEffect(() => {
    audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    masterGainRef.current = audioCtxRef.current.createGain();
    masterGainRef.current.gain.value = muted ? 0 : 1;
    masterGainRef.current.connect(audioCtxRef.current.destination);

    return () => {
      audioCtxRef.current && audioCtxRef.current.close();
    };
  }, []);

  useEffect(() => {
    if (masterGainRef.current) masterGainRef.current.gain.value = muted ? 0 : 1;
  }, [muted]);

  // helpers
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const keyFor = (x, y) => `${x},${y}`;

  // compute distance and volume
  function distance(a, b) {
    // Euclidean
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function computeGainForPlacement(placement, cursorPos) {
    if (!cursorPos) return 0;
    const d = distance({ x: placement.x, y: placement.y }, cursorPos);
    const radius = placement.params?.radius ?? defaultRadius;
    if (d > radius) return 0;
    // linear decay: 1 at dist 0 -> 0 at dist >= radius
    const base = 1 - d / radius;
    return base * (placement.params?.volume ?? 1);
  }

  // create and start oscillator playback for a newly placed synth
  function startPlacementSound(key, libItem, x, y, params) {
    const ctx = audioCtxRef.current;
    if (!ctx) return;

    // oscillator + gain -> master
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = libItem.freq;
    gain.gain.value = 0; // start silent; we'll update on cursor move
    osc.connect(gain);
    gain.connect(masterGainRef.current);
    const now = ctx.currentTime;
    osc.start(now);

    // save nodes in placements
    setPlacements(prev => ({
      ...prev,
      [key]: {
        ...prev[key],
        libId: libItem.id,
        x,
        y,
        params,
        nodes: { osc, gain }
      }
    }));
  }

  // stop and remove audio nodes for a placement
  function stopPlacementSound(key) {
    const ctx = audioCtxRef.current;
    const pl = placementsRef.current[key];
    if (!pl || !pl.nodes) return;
    try {
      pl.nodes.gain.gain.cancelScheduledValues(0);
      pl.nodes.gain.gain.setValueAtTime(0, ctx.currentTime);
      pl.nodes.osc.stop(ctx.currentTime + 0.02);
      pl.nodes.osc.disconnect();
      pl.nodes.gain.disconnect();
    } catch (e) {
      // ignore
    }
    setPlacements(prev => {
      const copy = { ...prev };
      delete copy[key];
      return copy;
    });
  }

  // update all placement gains based on current cursor
  function refreshPlacementGains(cursorPos) {
    const ctx = audioCtxRef.current;
    Object.entries(placementsRef.current).forEach(([key, pl]) => {
      if (!pl.nodes) return;
      const gainValue = computeGainForPlacement(pl, cursorPos);
      // smooth ramp
      try {
        pl.nodes.gain.gain.cancelScheduledValues(ctx.currentTime);
        pl.nodes.gain.gain.linearRampToValueAtTime(gainValue, ctx.currentTime + 0.05);
      } catch (e) {}
    });
  }

  // keyboard handling
  useEffect(() => {
    function onKeyDown(e) {
      const key = e.key;

      // Top menu shortcuts
      if (key === "1") {
        e.preventDefault();
        openAddRecordingDialog();
        return;
      }
      if (key === "2") {
        e.preventDefault();
        setMuted(m => !m);
        return;
      }
      if (key === "3") {
        e.preventDefault();
        setBlackout(b => !b);
        return;
      }

      // If search open, handle navigation/selection
      if (searchOpen) {
        if (key === "ArrowDown") {
          e.preventDefault();
          setSearchHighlightIdx(i => i + 1);
          return;
        }
        if (key === "ArrowUp") {
          e.preventDefault();
          setSearchHighlightIdx(i => Math.max(0, i - 1));
          return;
        }
        if (key === "Enter") {
          e.preventDefault();
          const list = filteredLibrary();
          const item = list[searchHighlightIdx] || list[0];
          if (item && cursorRef.current) selectLibraryItemForCursor(item);
          return;
        }
        if (key === "Escape") {
          setSearchOpen(false);
          return;
        }
      }

      // cursor movement keys
      const movementKeys = ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "a", "d", "w", "s"];
      if (movementKeys.includes(key)) {
        e.preventDefault();
        // initialize cursor if null
        if (!cursorRef.current) {
          const startX = Math.floor(cols / 2);
          const startY = 0;
          setCursor({ x: startX, y: startY });
          // after setting, update gains
          setTimeout(() => refreshPlacementGains({ x: startX, y: startY }), 10);
          return;
        }
        // move
        const cur = cursorRef.current;
        let nx = cur.x;
        let ny = cur.y;
        if (key === "ArrowLeft" || key === "a") nx = clamp(cur.x - 1, 0, cols - 1);
        if (key === "ArrowRight" || key === "d") nx = clamp(cur.x + 1, 0, cols - 1);
        if (key === "ArrowUp" || key === "w") ny = clamp(cur.y - 1, 0, rows - 1);
        if (key === "ArrowDown" || key === "s") ny = clamp(cur.y + 1, 0, rows - 1);
        setCursor({ x: nx, y: ny });
        refreshPlacementGains({ x: nx, y: ny });
        return;
      }

      // Delete/backspace behavior
      if (key === "Backspace" || key === "Delete") {
        if (cursorRef.current) {
          const k = keyFor(cursorRef.current.x, cursorRef.current.y);
          if (placementsRef.current[k]) {
            e.preventDefault();
            stopPlacementSound(k);
            return;
          }
        }
      }

      // 'e' to open editor if cell has placement
      if (key === "e") {
        if (cursorRef.current) {
          const k = keyFor(cursorRef.current.x, cursorRef.current.y);
          if (placementsRef.current[k]) {
            e.preventDefault();
            setEditorCell({ x: cursorRef.current.x, y: cursorRef.current.y });
            return;
          }
        }
      }

      // alphanumeric key opens searchable dropdown
      if (/^[a-z0-9]$/i.test(key)) {
        if (cursorRef.current) {
          e.preventDefault();
          setSearchInitiatorKey(key);
          setSearchQuery(key);
          setSearchOpen(true);
          setSearchHighlightIdx(0);
          return;
        }
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [cols, rows, searchOpen, searchHighlightIdx]);

  // filtered library
  function filteredLibrary() {
    const q = searchQuery.toLowerCase();
    return library.filter(item => item.name.toLowerCase().includes(q) || item.id.toLowerCase().includes(q));
  }

  // select library item to place on current cursor
  function selectLibraryItemForCursor(item) {
    const cur = cursorRef.current;
    if (!cur) return;
    const key = keyFor(cur.x, cur.y);
    // default params
    const params = { volume: 1, radius: defaultRadius, angularRange: 360, proximityTriggers: true, timing: 0 };
    setPlacements(prev => {
      // if exists, stop existing first
      if (prev[key] && prev[key].nodes) {
        try { prev[key].nodes.osc.stop(); } catch (e) {}
      }
      return {
        ...prev,
        [key]: { x: cur.x, y: cur.y, libId: item.id, params }
      };
    });
    // start audio nodes
    startPlacementSound(key, item, cur.x, cur.y, params);

    setSearchOpen(false);
  }

  // Add recording dialog (simple name+freq)
  function openAddRecordingDialog() {
    const name = prompt("Recording name (e.g. D5):");
    if (!name) return;
    const freqStr = prompt("Frequency in Hz (e.g. 440):");
    const freq = parseFloat(freqStr) || 440;
    const id = `lib-${Date.now()}`;
    setLibrary(prev => [...prev, { id, name, type: "synth", freq }]);
  }

  // editor save
  function saveEditor(params) {
    if (!editorCell) return;
    const key = keyFor(editorCell.x, editorCell.y);
    setPlacements(prev => ({ ...prev, [key]: { ...prev[key], params } }));
    // update node gain based on new params
    refreshPlacementGains(cursorRef.current);
    setEditorCell(null);
  }

  // render helpers
  function renderCell(x, y) {
    const key = keyFor(x, y);
    const has = !!placements[key];
    return (
      <div
        key={key}
        role="gridcell"
        aria-label={`Cell ${x + 1}, ${y + 1}${has ? ", has recording" : ""}`}
        className={`relative w-12 h-12 border border-gray-300 flex items-center justify-center ${blackout ? "bg-black" : "bg-white"}`}
      >
        {/* cursor outline */}
        {cursor && cursor.x === x && cursor.y === y && (
          <div className="absolute inset-0 border-2 border-black pointer-events-none" aria-hidden />
        )}
        {/* placed dot */}
        {has && (
          <div className="w-3 h-3 rounded-full bg-indigo-600" aria-hidden />
        )}
      </div>
    );
  }

  // when placements change, ensure gains reflect current cursor
  useEffect(() => {
    refreshPlacementGains(cursorRef.current);
  }, [placements]);

  return (
    <div className="p-4 font-sans">
      {/* Top menu */}
      <div className="flex items-center gap-4 mb-4">
        <div className="text-sm font-medium">Top Menu (keyboard shortcuts):</div>
        <div className="flex gap-3">
          <button className="px-3 py-1 rounded border" onClick={openAddRecordingDialog}>1 — Add recording</button>
          <button className="px-3 py-1 rounded border" onClick={() => setMuted(m => !m)}>2 — Toggle mute ({muted ? 'Muted' : 'Unmuted'})</button>
          <button className="px-3 py-1 rounded border" onClick={() => setBlackout(b => !b)}>3 — Toggle blackout ({blackout ? 'On' : 'Off'})</button>
        </div>
        <div className="ml-auto text-xs text-gray-500">Use Arrow keys or WASD to move. Press alphanumeric to assign a recording. Backspace/Delete removes. 'e' edits.</div>
      </div>

      <div className="flex gap-6">
        {/* grid */}
        <div>
          <div role="grid" aria-label="Soundscape grid" className={`grid grid-cols-${cols} gap-0`}> {/* tailwind dynamic class note: grid-cols-N only works for known N - this is a prototype */}
            {/* We'll render rows*cols cells manually */}
            <div className="grid" style={{ display: 'grid', gridTemplateColumns: `repeat(${cols}, 48px)` }}>
              {Array.from({ length: rows }).flatMap((_, y) =>
                Array.from({ length: cols }).map((_, x) => renderCell(x, y))
              )}
            </div>
          </div>
        </div>

        {/* right column: library and editor */}
        <div className="w-80">
          <div className="mb-4">
            <div className="text-sm font-semibold">Library</div>
            <ul className="mt-2 max-h-48 overflow-auto border rounded p-2">
              {library.map(item => (
                <li key={item.id} className="text-sm py-1 flex justify-between items-center">
                  <div>{item.name} <span className="text-xs text-gray-400">({item.freq} Hz)</span></div>
                  <div>
                    <button className="px-2 py-1 border rounded text-xs" onClick={() => {
                      // quick place under cursor if present
                      if (!cursor) return alert('Place the cursor with arrow keys first');
                      selectLibraryItemForCursor(item);
                    }}>Place</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>

          <div>
            <div className="text-sm font-semibold">Placements</div>
            <ul className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm">
              {Object.entries(placements).length === 0 && <li className="text-gray-500">No placements</li>}
              {Object.entries(placements).map(([k, pl]) => (
                <li key={k} className="py-1 flex justify-between">
                  <div>{k} — {library.find(l=>l.id===pl.libId)?.name || pl.libId}</div>
                  <div>
                    <button className="text-xs px-2 py-0.5 border rounded" onClick={() => stopPlacementSound(k)}>Remove</button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </div>

      {/* Search dropdown overlay */}
      {searchOpen && (
        <div className="fixed left-1/2 transform -translate-x-1/2 top-24 z-50 w-96 bg-white border rounded shadow-lg p-3">
          <div className="flex items-center gap-2 mb-2">
            <div className="text-sm">Select recording for cell</div>
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
                  onClick={() => selectLibraryItemForCursor(item)}
              >
                <div className="font-medium">{item.name}</div>
                <div className="text-xs text-gray-500">{item.freq} Hz</div>
              </li>
            ))}
            {filteredLibrary().length === 0 && <li className="p-2 text-gray-500">No results</li>}
          </ul>
        </div>
      )}

      {/* Editor panel */}
      {editorCell && (() => {
        const key = keyFor(editorCell.x, editorCell.y);
        const pl = placements[key];
        const libItem = library.find(l => l.id === pl?.libId);
        const params = pl?.params || {};
        let vol = params.volume ?? 1;
        let radius = params.radius ?? defaultRadius;
        let angularRange = params.angularRange ?? 360;
        let proximityTriggers = params.proximityTriggers ?? true;
        let timing = params.timing ?? 0;

        return (
          <div key={key} className="fixed right-6 top-24 w-96 bg-white border rounded shadow-lg p-4 z-40">
            <div className="flex items-center justify-between">
              <div className="font-semibold">Edit cell {editorCell.x},{editorCell.y}</div>
              <div className="text-xs text-gray-500">{libItem?.name || '—'}</div>
            </div>
            <div className="mt-3 space-y-3 text-sm">
              <div>
                <label className="block text-xs text-gray-600">Volume</label>
                <input type="range" min={0} max={2} step={0.01} defaultValue={vol}
                  onChange={(e) => { vol = parseFloat(e.target.value); }} />
              </div>
              <div>
                <label className="block text-xs text-gray-600">Radius</label>
                <input type="range" min={0.5} max={10} step={0.1} defaultValue={radius}
                  onChange={(e) => { radius = parseFloat(e.target.value); }} />
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