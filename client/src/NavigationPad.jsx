// --- Enhanced NavigationPad with Shift-Lock + Haptic Animations ---
import { motion } from "framer-motion";


export default function NavigationPad({ onMove, shiftLocked, setShiftLocked, pressedKey}) { // ensures visual reset on keyup

  function isPressed(targetKey) {
    // console.log("in isPressed", targetKey, pressedKey);
    return pressedKey && (pressedKey === targetKey);
  }
  // TODO: synchronize so logic and animation aren't handled separately when screen press?
  // fixed bottom-6 right-6 select-none z-50

  return (
    <div className="flex flex-row md:flex-col items-center justify-center gap-3">
      {/* Shift-Lock Toggle */}
      <motion.button
        whileTap={{ scale: 0.85 }}
        animate={shiftLocked ? { scale: 1.15 } : { scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className={`px-4 py-2 rounded-full shadow text-sm font-semibold transition-colors text-white ${shiftLocked ? 'bg-blue-600' : 'bg-gray-700'}`}
        onClick={() => setShiftLocked(!shiftLocked)}
      >
        {shiftLocked ? 'SHIFT: ON' : 'SHIFT: OFF'}
      </motion.button>

      {/* <div className="flex flex-row items-center justify-center gap-2"> */}
        {/* Up */}
        <motion.button
          whileTap={{ scale: 0.85 }}
          animate={isPressed('arrowup') ? { scale: 0.8 } : { scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          className="w-12 h-12 rounded-full bg-gray-800 hover:bg-gray-700 active:bg-gray-600 flex items-center justify-center text-white text-xl shadow"
          onClick={() => onMove('up')}
        >
          ↑
        </motion.button>

        <div className="flex gap-2">
          {/* Left */}
          <motion.button
            whileTap={{ scale: 0.85 }}
            animate={isPressed('arrowleft') ? { scale: 0.8 } : { scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="w-12 h-12 rounded-full bg-gray-800 hover:bg-gray-700 active:bg-gray-600 flex items-center justify-center text-white text-xl shadow"
            onClick={() => onMove('left')}
          >
            ←
          </motion.button>

          {/* Right */}
          <motion.button
            whileTap={{ scale: 0.85 }}
            animate={isPressed('arrowright') ? { scale: 0.8 } : { scale: 1 }}
            transition={{ type: 'spring', stiffness: 300, damping: 20 }}
            className="w-12 h-12 rounded-full bg-gray-800 hover:bg-gray-700 active:bg-gray-600 flex items-center justify-center text-white text-xl shadow"
            onClick={() => onMove('right')}
          >
            →
          </motion.button>
        </div>

        {/* Down */}
        <motion.button
          whileTap={{ scale: 0.85 }}
          animate={isPressed('arrowdown') ? { scale: 0.8 } : { scale: 1 }}
          transition={{ type: 'spring', stiffness: 300, damping: 20 }}
          className="w-12 h-12 rounded-full bg-gray-800 hover:bg-gray-700 active:bg-gray-600 flex items-center justify-center text-white text-xl shadow"
          onClick={() => onMove('down')}
        >
          ↓
        </motion.button>
      {/* </div> */}

      {/* Clear (ESC) */}
      <motion.button
      whileTap={{ scale: 0.85 }}
        animate={ isPressed('escape') ? { scale: 0.8 } : { scale: 1 }}
        transition={{ type: 'spring', stiffness: 300, damping: 20 }}
        className="px-4 py-2 rounded-full bg-red-700 hover:bg-red-600 active:bg-red-500 text-white text-sm shadow mt-2"
        onClick={() => onMove('escape')}
      >
        ESC
      </motion.button>
    </div>
  );
}