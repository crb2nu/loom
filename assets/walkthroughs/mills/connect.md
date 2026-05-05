# Connect Loom to your Mills HUD

The Loom extension talks to a running **Mills HUD** (the Loom-core web UI) at `/api/mills/*`. Until you point the extension at that HUD, the **Loom Mills** view sits idle.

## Set the HUD URL

Open settings (⌘,) and set:

```
loom.mills.hudBaseUrl = https://hud.your-cluster.example
```

The status bar gains a **Mills** indicator within a minute. Empty value hides the surface entirely — no clutter for users who don't use Mills.
