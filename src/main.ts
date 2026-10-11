import { createCliRenderer } from "@opentui/core"
import { createSyncWeaveApp } from "./app.js"

const renderer = await createCliRenderer({ exitOnCtrlC: false })
const app = createSyncWeaveApp(renderer)

renderer.on("destroy", app.dispose)
renderer.start()
