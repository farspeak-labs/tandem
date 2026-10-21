import { createRoot } from "react-dom/client";
import { App } from "./App";
import "@fontsource-variable/inter";
import "./styles.css";

// Platform class for chrome differences (macOS draws traffic lights inside the title bar).
const platform = (window as unknown as { tandem?: { platform?: string } }).tandem?.platform ?? (/Mac/.test(navigator.platform) ? "darwin" : "other");
document.documentElement.classList.add(`platform-${platform}`);

createRoot(document.getElementById("root")!).render(<App />);
