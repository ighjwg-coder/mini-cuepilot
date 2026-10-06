import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';

export function TopBar({ children }: { children?: ReactNode }) {
  return (
    <header className="topbar">
      <h1>⛪ Mini CuePilot</h1>
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
