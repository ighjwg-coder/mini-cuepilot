import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { CueScreenPage } from './pages/CueScreenPage';
import { EditorPage } from './pages/EditorPage';
import { DevicesPage } from './pages/DevicesPage';
import { DirectorPage } from './pages/DirectorPage';
import { HomePage } from './pages/HomePage';
import { PrintPage } from './pages/PrintPage';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/director" element={<DirectorPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/editor/:id" element={<EditorPage />} />
        <Route path="/devices" element={<DevicesPage />} />
        <Route path="/cam/:n" element={<CueScreenPage />} />
        <Route path="/print/:id" element={<PrintPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
