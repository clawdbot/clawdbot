import { create } from "zustand"

interface AppState {
  // Selected items
  selectedAgentId: string | null
  selectedSessionKey: string | null
  
  // Live feed state
  isLiveFeedPaused: boolean
  liveEvents: string[]
  maxLiveEvents: number
  
  // Actions
  setSelectedAgentId: (id: string | null) => void
  setSelectedSessionKey: (key: string | null) => void
  toggleLiveFeed: () => void
  addLiveEvent: (event: string) => void
  clearLiveEvents: () => void
}

export const useAppStore = create<AppState>((set, get) => ({
  selectedAgentId: null,
  selectedSessionKey: null,
  isLiveFeedPaused: false,
  liveEvents: [],
  maxLiveEvents: 500,
  
  setSelectedAgentId: (id) => set({ selectedAgentId: id }),
  setSelectedSessionKey: (key) => set({ selectedSessionKey: key }),
  
  toggleLiveFeed: () => set((state) => ({ isLiveFeedPaused: !state.isLiveFeedPaused })),
  
  addLiveEvent: (event) => {
    if (get().isLiveFeedPaused) return
    set((state) => ({
      liveEvents: [event, ...state.liveEvents].slice(0, state.maxLiveEvents),
    }))
  },
  
  clearLiveEvents: () => set({ liveEvents: [] }),
}))
