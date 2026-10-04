"""Make Capacitor's fused location deliver fixes instead of batching them.

The stock plugin sets maxUpdateDelayMillis from the JS timeout, so a 30s
timeout holds updates for up to 30s and the map marker stays put.
"""
from pathlib import Path

path = Path("node_modules/@capacitor/geolocation/android/src/main/java/com/capacitorjs/plugins/geolocation/Geolocation.java")
text = path.read_text()
old = """                LocationRequest locationRequest = new LocationRequest.Builder(10000)
                    .setMaxUpdateDelayMillis(timeout)
                    .setMinUpdateIntervalMillis(minUpdateInterval)
                    .setPriority(priority)
                    .build();
"""
new = """                // Deliver each fix as it arrives. The old max-delay used the JS
                // timeout (often 30s), so the map sat still while the user moved.
                int interval = Math.max(1000, Math.min(minUpdateInterval, 2000));
                LocationRequest locationRequest = new LocationRequest.Builder(interval)
                    .setMinUpdateIntervalMillis(interval)
                    .setWaitForAccurateLocation(false)
                    .setPriority(priority)
                    .build();
"""
if new in text:
    print("fused location patch already applied")
elif old not in text:
    raise SystemExit("fused location patch target not found")
else:
    path.write_text(text.replace(old, new, 1))
    print("fused location patch applied")
