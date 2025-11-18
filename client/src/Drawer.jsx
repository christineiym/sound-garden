// --- Navigation Drawer (Enhanced: Layout wrapper + Router Links + Framer Motion + Focus Trap) ---
import React, { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";

export default function LeftDrawer({ links }) {
  const [open, setOpen] = useState(false);
  const drawerRef = useRef(null);

  // Focus trap
  useEffect(() => {
    if (open && drawerRef.current) {
      const focusable = drawerRef.current.querySelectorAll(
        'button, [href], input, select, textarea, [tabindex]'
      );
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      first.focus();

      function handleKey(e) {
        if (e.key === "Tab") {
          if (e.shiftKey) {
            if (document.activeElement === first) {
              e.preventDefault();
              last.focus();
            }
          } else {
            if (document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }
        if (e.key === "Escape") setOpen(false);
      }
      document.addEventListener("keydown", handleKey);
      return () => document.removeEventListener("keydown", handleKey);
    }
  }, [open]);

  return (
    <>
      <button
        aria-label="Open menu"
        className="fixed top-4 left-4 z-50 p-2 rounded-lg bg-gray-800 hover:bg-gray-700"
        onClick={() => setOpen(true)}
      >
        <div className="space-y-1">
          <span className="block h-0.5 w-6 bg-white" />
          <span className="block h-0.5 w-6 bg-white" />
          <span className="block h-0.5 w-6 bg-white" />
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <>
            <motion.div
              key="backdrop"
              className="fixed inset-0 bg-black bg-opacity-30 z-40"
              initial={{ opacity: 0 }}
              animate={{ opacity: 0.5 }}
              exit={{ opacity: 0 }}
              onClick={() => setOpen(false)}
            />

            <motion.aside
              key="drawer"
              ref={drawerRef}
              className="fixed top-0 left-0 h-full w-64 bg-gray-900 text-white z-50 p-4 border-r border-gray-700"
              initial={{ x: "-100%" }}
              animate={{ x: 0 }}
              exit={{ x: "-100%" }}
              transition={{ type: "spring", stiffness: 300, damping: 30 }}
            >
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold">Menu</h2>
                <button
                  aria-label="Close menu"
                  className="p-1 rounded hover:bg-gray-700"
                  onClick={() => setOpen(false)}
                >
                  ✕
                </button>
              </div>
              <nav className="space-y-2">
                {links.map((link) => (
                  <Link
                    key={link.to}
                    to={link.to}
                    className="block px-3 py-2 rounded font-semibold text-white hover:bg-gray-700"
                    onClick={() => setOpen(false)}
                  >
                    {link.label}
                  </Link>
                ))}
              </nav>
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}