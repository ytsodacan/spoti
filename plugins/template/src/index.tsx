import { findByName, findByProps } from "@vendetta/metro";
import { React, ReactNative } from "@vendetta/metro/common";
import { after } from "@vendetta/patcher";
import { showToast } from "@vendetta/ui/toasts";

const { TouchableOpacity, Image } = ReactNative;

// --- Discord Internal Metro Modules ---
const { getActivities } = findByProps("getActivities") || {};
const UserStore = findByProps("getCurrentUser");
const MessageActions = findByProps("sendMessage");
const SelectedChannelStore = findByProps("getChannelId");

let patches: (() => void)[] = [];

// --- Global State ---
let isLive = false;
let syncInterval: any = null;
let currentLrcData: string | null = null;
let lastSentLyric = "";
let activeTrack = "";

async function fetchLyrics(track: string, artist: string) {
    try {
        const res = await fetch(`https://lrclib.net/api/get?track_name=${encodeURIComponent(track)}&artist_name=${encodeURIComponent(artist)}`);
        if (!res.ok) return null;
        const data = await res.json();
        return data.syncedLyrics; 
    } catch (e) {
        return null;
    }
}

function getCurrentLyric(lrc: string, progressMs: number) {
    if (!lrc) return null;
    const lines = lrc.split('\n');
    let currentLine = null;
    for (const line of lines) {
        const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
        if (match) {
            const min = parseInt(match[1]);
            const sec = parseFloat(match[2]);
            const timeMs = (min * 60 + sec) * 1000;
            if (timeMs <= progressMs) {
                const text = match[3].trim();
                if (text) currentLine = text;
            } else { break; }
        }
    }
    return currentLine;
}

function stopLiveLyrics() {
    isLive = false;
    if (syncInterval) clearInterval(syncInterval);
    syncInterval = null;
    currentLrcData = null;
    lastSentLyric = "";
    activeTrack = "";
}

const LyricsToggleBtn = () => {
    const [active, setActive] = React.useState(isLive);

    const toggleLyrics = async () => {
        if (active) {
            setActive(false);
            stopLiveLyrics();
            showToast("Live Lyrics stopped.");
            return;
        }

        const currentUser = UserStore?.getCurrentUser();
        if (!currentUser) return showToast("User not found");

        const activities = getActivities?.(currentUser.id);
        const spotify = activities?.find((a: any) => a.name === "Spotify" && a.type === 2);
        
        if (!spotify) return showToast("No Spotify activity detected!");

        const track = spotify.details;
        const artist = spotify.state;
        
        showToast(`Starting lyrics for ${track}...`);
        setActive(true);
        isLive = true;
        activeTrack = track;
        
        const lyricsLrc = await fetchLyrics(track, artist);
        if (!lyricsLrc) {
            showToast("No synced lyrics found.");
            setActive(false);
            stopLiveLyrics();
            return;
        }
        
        currentLrcData = lyricsLrc;

        syncInterval = setInterval(() => {
            const currentActivities = getActivities?.(currentUser.id);
            const currentSpotify = currentActivities?.find((a: any) => a.name === "Spotify" && a.type === 2);
            
            if (!currentSpotify || currentSpotify.details !== activeTrack) {
                setActive(false);
                stopLiveLyrics();
                return;
            }

            const start = currentSpotify.timestamps?.start;
            if (!start) return;

            const progressMs = Date.now() - start;
            const currentLine = getCurrentLyric(currentLrcData!, progressMs);
            
            if (currentLine && currentLine !== lastSentLyric) {
                lastSentLyric = currentLine;
                const channelId = SelectedChannelStore?.getChannelId();
                if (channelId) {
                    MessageActions.sendMessage(channelId, { content: `🎤 *${currentLine}*` });
                }
            }
        }, 1000);
    };

    return (
        <TouchableOpacity 
            key="spotify-lyrics-btn"
            style={{ marginHorizontal: 12, justifyContent: 'center' }}
            onPress={toggleLyrics}
        >
            <Image 
                source={{ uri: "https://upload.wikimedia.org/wikipedia/commons/1/19/Spotify_logo_without_text.svg" }} 
                style={{ width: 22, height: 22, tintColor: active ? "#1DB954" : "#B5BAC1" }} 
            />
        </TouchableOpacity>
    );
};

export default {
    onLoad: () => {
        try {
            // Updated list of possible Header component names
            const Header = findByName("Header", false) 
                        || findByName("ChannelHeader", false) 
                        || findByName("ChannelTitle", false);
            
            if (!Header) return console.error("[Spotify] Header not found.");
            
            // Patch the component. We check both 'default' and the object itself.
            const patchTarget = Header.default ? Header : { default: Header };

            patches.push(after("default", patchTarget, (args, res) => {
                if (!res) return;

                // Dig through common Discord UI paths to find where the icons live
                const topBar = res?.props?.children?.props?.right 
                            || res?.props?.right 
                            || res?.props?.children?.props?.children?.props?.right;

                if (Array.isArray(topBar)) {
                    if (!topBar.some((c: any) => c?.key === "spotify-lyrics-btn")) {
                        topBar.unshift(<LyricsToggleBtn key="spotify-lyrics-btn" />);
                    }
                }
            }));

            showToast("Spotify Lyrics Loaded!");
        } catch (err) {
            console.error("[Spotify] Load Error:", err);
        }
    },
    onUnload: () => {
        stopLiveLyrics();
        patches.forEach(unpatch => unpatch());
    }
};
