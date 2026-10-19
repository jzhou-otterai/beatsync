// The hosted room starts without a "Start System" click, so on phones the browser keeps
// audio suspended until the first tap. If nothing asks for that tap, or the tap doesn't
// resume audio, the listener sits in a room that looks live but is silent.

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { EnableSoundPrompt } from "@/components/room/EnableSoundPrompt";
import { audioContextManager } from "@/lib/audioContextManager";
import { useGlobalStore } from "@/store/global";

const initialGlobalState = useGlobalStore.getState();

describe("EnableSoundPrompt", () => {
  let state: AudioContextState = "suspended";

  beforeEach(() => {
    state = "suspended";
    spyOn(audioContextManager, "getState").mockImplementation(() => state);
    spyOn(audioContextManager, "resume").mockImplementation(async () => {
      state = "running";
    });
    useGlobalStore.setState({ hasUserStartedSystem: true });
  });

  afterEach(() => {
    mock.restore();
    useGlobalStore.setState(initialGlobalState, true);
  });

  it("asks for a tap while audio is blocked, and the tap turns sound on", async () => {
    const { queryByText } = render(<EnableSoundPrompt />);
    expect(queryByText("Tap anywhere to turn on sound")).not.toBeNull();

    await act(async () => {
      fireEvent.pointerDown(document.body);
    });

    expect(audioContextManager.resume).toHaveBeenCalled();
    await waitFor(() => expect(queryByText("Tap anywhere to turn on sound")).toBeNull());
  });

  it("stays out of the way when the browser allows autoplay", () => {
    state = "running";
    const { queryByText } = render(<EnableSoundPrompt />);
    expect(queryByText("Tap anywhere to turn on sound")).toBeNull();
  });
});
