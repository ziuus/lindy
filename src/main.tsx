import React, { useMemo, useState, useEffect } from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "@mui/material/styles";
import CssBaseline from "@mui/material/CssBaseline";
import { createAppTheme, Accent, ACCENT_ORDER } from "./theme";
export const ThemeContext = React.createContext<{ mode: 'light' | 'dark'; accent: Accent; toggleMode: () => void; setAccent: (a: Accent) => void; cycleAccent: () => void }>({ mode: 'dark', accent: 'green', toggleMode: () => {}, setAccent: () => {}, cycleAccent: () => {} });

function Root() {
  const [mode, setMode] = useState<'light' | 'dark'>(() => (localStorage.getItem('themeMode') as 'light' | 'dark') || 'dark');
  const [accent, setAccent] = useState<Accent>(() => (localStorage.getItem('themeAccent') as Accent) || 'green');
  useEffect(() => { try { localStorage.setItem('themeMode', mode); } catch {} }, [mode]);
  useEffect(() => { try { localStorage.setItem('themeAccent', accent); } catch {} }, [accent]);
  const theme = useMemo(() => createAppTheme(mode, accent), [mode, accent]);
  const ctx = useMemo(() => ({
    mode,
    accent,
    toggleMode: () => setMode(m => m === 'dark' ? 'light' : 'dark'),
    setAccent,
    cycleAccent: () => setAccent(a => {
      const idx = ACCENT_ORDER.indexOf(a);
      const next = ACCENT_ORDER[(idx + 1) % ACCENT_ORDER.length];
      return next;
    })
  }), [mode, accent]);
  return (
    <ThemeContext.Provider value={ctx}>
      <ThemeProvider theme={theme}>
        <CssBaseline />
        <App />
      </ThemeProvider>
    </ThemeContext.Provider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
