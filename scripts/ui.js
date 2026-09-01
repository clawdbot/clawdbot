#!/usr/bin/env node
import { runUiCli } from "./ui.mts";

// Native imports avoid loader startup and leave process lifetime with the UI owner.
runUiCli();
