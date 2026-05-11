import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from 'react-query'
import { Toaster } from 'react-hot-toast'

import './index.css'
import { AppShell } from './components/AppShell'
import DashboardPage from './pages/Dashboard'
import SearchPage from './pages/Search'
import FileDetailPage from './pages/FileDetail'
import DuplicatesPage from './pages/Duplicates'
import SourcesPage from './pages/Sources'
import FoldersPage from './pages/Folders'
import TimelinePage from './pages/Timeline'

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 30_000,
      refetchOnWindowFocus: false,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppShell>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/search" element={<SearchPage />} />
            <Route path="/files/:fileId" element={<FileDetailPage />} />
            <Route path="/duplicates" element={<DuplicatesPage />} />
            <Route path="/sources" element={<SourcesPage />} />
            <Route path="/folders" element={<FoldersPage />} />
            <Route path="/timeline" element={<TimelinePage />} />
            <Route path="/timeline/:id" element={<TimelinePage />} />
          </Routes>
        </AppShell>
        <Toaster
          position="bottom-right"
          toastOptions={{
            style: {
              background: '#18181b',
              color: '#e4e4e7',
              border: '1px solid #27272b',
              fontSize: '13px',
            },
            success: { iconTheme: { primary: '#f59e0b', secondary: '#18181b' } },
          }}
        />
      </BrowserRouter>
    </QueryClientProvider>
  </React.StrictMode>
)
