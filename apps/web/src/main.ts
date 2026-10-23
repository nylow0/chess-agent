import { mount } from "svelte";
import "@fontsource-variable/figtree";
import "chessground/assets/chessground.base.css";
import "./app.css";
import "./board.css";
import App from "./App.svelte";

const app = mount(App, { target: document.getElementById("app")! });

export default app;
