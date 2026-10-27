import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './context/ThemeContext'
import { logAppVisitOnce } from './services/telemetry'
import LandingPage from './app/pages/LandingPage'
import RoomPage from './app/pages/RoomPage'
import ArenaPage from './app/pages/ArenaPage'
import ResultPage from './app/pages/ResultPage'

export default function App() {
  useEffect(() => {
    // Record IP visit to Supabase bucket on initial load
    logAppVisitOnce()
  }, [])

  return (
    <ThemeProvider>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/join/:code" element={<LandingPage />} />
          <Route path="/room/:roomId" element={<RoomPage />} />
          <Route path="/room/:roomId/arena" element={<ArenaPage />} />
          <Route path="/room/:roomId/result" element={<ResultPage />} />
        </Routes>
      </BrowserRouter>
    </ThemeProvider>
  )
}
