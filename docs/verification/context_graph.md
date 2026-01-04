This walkthrough details how to verify the new Context Graph feature.

## Prerequisites

- Ensure you have the Loom extension installed (or running in debug mode).
- Ensure your `registry.yaml` has at least one server defined.
- Ensure the Loom Daemon (`loomd`) is running.

## Verification Steps

1. **Open the Context Graph**
   - Open the Command Palette (`Cmd+Shift+P`).
   - Run the command: `Loom: Show Context Graph`.

2. **Verify Rendering**
   - A new tab should open with the title "Loom Context Graph".
   - You should see a central "MCP Hub" node.
   - Connected nodes (representing your MCP servers) should branch out from the hub.
   - The graph should gently float/settle (physics simulation).

3. **Verify Aesthetics**
   - **Hub Node**: Check that the center node has a "glow" effect.
   - **Colors**:
     - If the Hub is healthy, the center node should be green-ish.
     - If the Hub is unreachable, it should be red-ish.
     - Server nodes should be blue-ish.
   - **Dark Mode**: The background should match the VS Code editor background.

4. **Verify Interactivity**
   - **Drag**: Click and drag a node. It should move and pull connected nodes.
   - **Zoom/Pan**: Use your mouse wheel or trackpad to zoom in/out and pan around the canvas.
   - **Hover**: Hover over a node to see a tooltip with its full name.

5. **Verify Live Updates**
   - While the graph is open, modify your `registry.yaml` (add or remove a server).
   - The graph should automatically update to reflect the changes (nodes appearing/disappearing) without needing to reload the window.
