import { useEffect } from 'react'
import { BrowserRouter, Route, Routes } from 'react-router-dom'
import { ThemeProvider } from './context/ThemeContext'
import { AuthProvider } from './context/AuthContext'
import { SocialProvider } from './context/SocialContext'
import { logAppVisitOnce } from './services/telemetry'
import LandingPage from './app/pages/LandingPage'
import RoomPage from './app/pages/RoomPage'
import ArenaPage from './app/pages/ArenaPage'
import ResultPage from './app/pages/ResultPage'
import CreatorDashboardPage from './app/pages/CreatorDashboardPage'
import LoginPage from './app/pages/LoginPage'
import ProfilePage from './app/pages/ProfilePage'
import FriendsPage from './app/pages/FriendsPage'
import PlayerPage from './app/pages/PlayerPage'
import PlayersPage from './app/pages/PlayersPage'
import { SocialOverlay } from './app/components/SocialOverlay'

export default function App() {
  useEffect(() => {
    // Record IP visit to Supabase bucket on initial load
    logAppVisitOnce()
  }, [])

  return (
    <ThemeProvider>
      <AuthProvider>
        <BrowserRouter>
          <SocialProvider>
            <Routes>
              <Route path="/" element={<LandingPage />} />
              <Route path="/join/:code" element={<LandingPage />} />
              <Route path="/room/:roomId" element={<RoomPage />} />
              <Route path="/room/:roomId/arena" element={<ArenaPage />} />
              <Route path="/room/:roomId/result" element={<ResultPage />} />
              <Route path="/creator" element={<CreatorDashboardPage />} />
              <Route path="/login" element={<LoginPage />} />
              <Route path="/profile" element={<ProfilePage />} />
              <Route path="/friends" element={<FriendsPage />} />
              <Route path="/players" element={<PlayersPage />} />
              <Route path="/u/:code" element={<PlayerPage />} />
            </Routes>
            <SocialOverlay />
          </SocialProvider>
        </BrowserRouter>
      </AuthProvider>
    </ThemeProvider>
  )
}
