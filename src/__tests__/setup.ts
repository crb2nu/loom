/**
 * Vitest setup file for loom extension tests
 * Runs before all tests to configure the test environment
 */
import { vi, beforeEach, afterAll } from "vitest";

// Reset all mocks before each test
beforeEach(() => {
  vi.clearAllMocks();
});

// Clean up after all tests
afterAll(() => {
  vi.restoreAllMocks();
});
