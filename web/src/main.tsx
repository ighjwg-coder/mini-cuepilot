import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { CueScreenPage } from './pages/CueScreenPage';
import { EditorPage } from './pages/EditorPage';
import { DirectorPage } from './pages/DirectorPage';
import { HomePage } from './pages/HomePage';
import './styles.css';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<HomePage />} />
        <Route path="/director" element={<DirectorPage />} />
        <Route path="/editor" element={<EditorPage />} />
        <Route path="/editor/:id" element={<EditorPage />} />
        <Route path="/cam/:n" element={<CueScreenPage />} />
        <Route path="*" element={<HomePage />} />
      </Routes>
    </BrowserRouter>
  </StrictMode>,
);
