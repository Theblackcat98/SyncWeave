import { createCliRenderer } from "@opentui/core"
import { createApp } from "./app"

const renderer = await createCliRenderer({ exitOnCtrlC: false })
createApp(renderer)
renderer.start()
