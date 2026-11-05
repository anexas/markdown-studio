import "github-markdown-css/github-markdown.css";
import "katex/dist/katex.min.css";
import "./styles/app.css";

import { bootError, initApp } from "./app";

initApp().catch(bootError);
