import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'
import { BrowserRouter as Router, Routes, Route } from "react-router"
import Layout from './Layout.jsx'
import GridNote from './GridNote.jsx'
import GridUrban from './GridUrban.jsx'
import GridUrbanAdvanced from './GridUrbanAdvanced.jsx'

const allLinks = [
            { to: "/sound-garden/notes", label: "Notes Grid" },
            { to: "/sound-garden/urban", label: "Urban Grid" },
          ]

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <Router>
      <Routes>
        <Route path="/sound-garden" element={<Layout children={<App/>} links={allLinks} />} />
        <Route path="/sound-garden/notes" element={<Layout children={<GridNote/>} links={allLinks} />} />
        <Route path="/sound-garden/urban" element={<Layout children={<GridUrbanAdvanced/>} links={allLinks} />} />
      </Routes>
    </Router>
  </StrictMode>,
)