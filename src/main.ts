import "github-markdown-css/github-markdown.css";
import "./styles/app.css";

import { bootError, initApp } from "./app";

initApp().catch(bootError);
