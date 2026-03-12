package main

import (
	"testing"
)

func TestParseTopic(t *testing.T) {
	base := "ebus/5/dev-1/"

	tests := []struct {
		name     string
		topic    string
		wantNode string
		wantProp string
		wantSpec string
		wantIgn  bool
		wantNP   bool
		wantNS   bool
	}{
		{
			name:     "normal property",
			topic:    "ebus/5/dev-1/core/voltage",
			wantNode: "core",
			wantProp: "voltage",
		},
		{
			name:     "circuit property",
			topic:    "ebus/5/dev-1/abc123/power",
			wantNode: "abc123",
			wantProp: "power",
		},
		{
			name:     "kebab-case property",
			topic:    "ebus/5/dev-1/core/relay-state",
			wantNode: "core",
			wantProp: "relay-state",
		},
		{
			name:     "$description",
			topic:    "ebus/5/dev-1/$description",
			wantSpec: "$description",
		},
		{
			name:     "$state",
			topic:    "ebus/5/dev-1/$state",
			wantSpec: "$state",
		},
		{
			name:    "other $ topic",
			topic:   "ebus/5/dev-1/$extensions",
			wantIgn: true,
		},
		{
			name:    "nested $ under node",
			topic:   "ebus/5/dev-1/core/$name",
			wantIgn: true,
		},
		{
			name:   "wrong prefix",
			topic:  "other/topic/completely",
			wantNP: true,
		},
		{
			name:   "no slash after node",
			topic:  "ebus/5/dev-1/just-a-node",
			wantNS: true,
		},
		{
			name:     "deeply nested — only first slash matters",
			topic:    "ebus/5/dev-1/node/prop/sub",
			wantNode: "node",
			wantProp: "prop/sub",
		},
		{
			name:   "empty rest",
			topic:  "ebus/5/dev-1/",
			wantNS: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			r := parseTopic(base, tt.topic)

			if r.Node != tt.wantNode {
				t.Errorf("Node = %q, want %q", r.Node, tt.wantNode)
			}
			if r.Property != tt.wantProp {
				t.Errorf("Property = %q, want %q", r.Property, tt.wantProp)
			}
			if r.Special != tt.wantSpec {
				t.Errorf("Special = %q, want %q", r.Special, tt.wantSpec)
			}
			if r.Ignored != tt.wantIgn {
				t.Errorf("Ignored = %v, want %v", r.Ignored, tt.wantIgn)
			}
			if r.NoPrefix != tt.wantNP {
				t.Errorf("NoPrefix = %v, want %v", r.NoPrefix, tt.wantNP)
			}
			if r.NoSlash != tt.wantNS {
				t.Errorf("NoSlash = %v, want %v", r.NoSlash, tt.wantNS)
			}
		})
	}
}

func TestParseTopicDifferentBases(t *testing.T) {
	tests := []struct {
		base     string
		topic    string
		wantNode string
		wantProp string
	}{
		{"ebus/5/dev-a/", "ebus/5/dev-a/core/voltage", "core", "voltage"},
		{"custom/prefix/mydev/", "custom/prefix/mydev/n1/p1", "n1", "p1"},
		{"a/b/c/", "a/b/c/node/prop", "node", "prop"},
	}
	for _, tt := range tests {
		t.Run(tt.base, func(t *testing.T) {
			r := parseTopic(tt.base, tt.topic)
			if r.Node != tt.wantNode || r.Property != tt.wantProp {
				t.Errorf("got Node=%q Property=%q, want %q/%q", r.Node, r.Property, tt.wantNode, tt.wantProp)
			}
		})
	}
}
