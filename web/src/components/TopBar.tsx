import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { APP_VERSION } from '@shared/version';

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>
        ⛪ Mini CuePilot <small className="muted mono" style={{ fontWeight: 400, fontSize: 11 }}>v{APP_VERSION}</small>
      </h1>
      <nav>
        <NavLink to="/" end>
          홈
        </NavLink>
        <NavLink to="/director">디렉터</NavLink>
        <NavLink to="/editor">에디터</NavLink>
      </nav>
      <div className="spacer" />
      {children}
    </header>
  );
}
