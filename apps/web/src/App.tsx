import React, { useState, useEffect, useCallback } from "react";
import { 
  Container, 
  Row, 
  Col, 
  Form, 
  InputGroup, 
  Button, 
  Card, 
  Badge, 
  Modal, 
  Navbar,
  Nav,
  Dropdown,
  Spinner
} from "react-bootstrap";
import { 
  Search, 
  Plus, 
  Star, 
  Trash2, 
  Tag as TagIcon, 
  Clipboard, 
  Clock, 
  Smartphone,
  Hash,
  Filter,
  RefreshCw,
  Copy,
  Check
} from "lucide-react";
import type { ClipItem, ClipListResponse, ApiResponse } from "@paste/shared";

const API_BASE =
  import.meta.env.VITE_API_BASE ??
  (window.location.hostname === "paste.misonote.com"
    ? "https://pasteapi.misonote.com/v1"
    : "/v1");

// Simple ID storage for demo purposes
const USER_ID = localStorage.getItem("paste_user_id") || "user_demo";
const DEVICE_ID = localStorage.getItem("paste_device_id") || "device_web";

localStorage.setItem("paste_user_id", USER_ID);
localStorage.setItem("paste_device_id", DEVICE_ID);

const App: React.FC = () => {
  const [clips, setClips] = useState<ClipItem[]>([]);
  const [tags, setTags] = useState<{name: string, clipCount: number}[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedTag, setSelectedTag] = useState<string | null>(null);
  const [favoriteOnly, setFavoriteOnly] = useState(false);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [tempUserId, setTempUserId] = useState(USER_ID);
  const [tempDeviceId, setTempDeviceId] = useState(DEVICE_ID);
  const [newClipContent, setNewClipContent] = useState("");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const saveSettings = () => {
    localStorage.setItem("paste_user_id", tempUserId);
    localStorage.setItem("paste_device_id", tempDeviceId);
    window.location.reload();
  };

  // Debounce search query
  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedSearch(searchQuery);
    }, 300);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  const fetchTags = useCallback(async () => {
    try {
      const res = await fetch(`${API_BASE}/tags`, {
        headers: {
          "x-user-id": USER_ID,
          "x-device-id": DEVICE_ID,
        },
      });
      const data: ApiResponse<{name: string, clipCount: number}[]> = await res.json();
      if (data.ok) {
        setTags(data.data);
      }
    } catch (err) {
      console.error("Failed to fetch tags", err);
    }
  }, []);

  const fetchClips = useCallback(async (isLoadMore = false) => {
    if (isLoadMore) setLoadingMore(true);
    else setLoading(true);

    try {
      const params = new URLSearchParams();
      if (debouncedSearch) params.append("q", debouncedSearch);
      if (selectedTag) params.append("tag", selectedTag);
      if (favoriteOnly) params.append("favorite", "1");
      if (isLoadMore && nextCursor) params.append("cursor", nextCursor);
      params.append("limit", "24");

      const res = await fetch(`${API_BASE}/clips?${params.toString()}`, {
        headers: {
          "x-user-id": USER_ID,
          "x-device-id": DEVICE_ID,
        },
      });
      const data: ApiResponse<ClipListResponse> = await res.json();
      if (data.ok) {
        if (isLoadMore) {
          setClips(prev => [...prev, ...data.data.items]);
        } else {
          setClips(data.data.items);
        }
        setNextCursor(data.data.nextCursor);
        setHasMore(data.data.hasMore);
      }
    } catch (err) {
      console.error("Failed to fetch clips", err);
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }, [debouncedSearch, selectedTag, favoriteOnly, nextCursor]);

  useEffect(() => {
    fetchClips();
    fetchTags();
  }, [debouncedSearch, selectedTag, favoriteOnly]); // Refetch on filter change

  const handleCreateClip = async () => {
    if (!newClipContent.trim()) return;
    
    // Optimistic UI could be done here, but since it's a new item, 
    // we usually wait for the ID from the server unless we generate it locally.
    try {
      const res = await fetch(`${API_BASE}/clips`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-user-id": USER_ID,
          "x-device-id": DEVICE_ID,
        },
        body: JSON.stringify({
          content: newClipContent,
          type: "text",
          clientUpdatedAt: Date.now(),
        }),
      });
      const data: ApiResponse<ClipItem> = await res.json();
      if (data.ok) {
        setClips([data.data, ...clips]);
        setNewClipContent("");
        setShowAddModal(false);
        fetchTags(); // Update tag counts
      }
    } catch (err) {
      console.error("Failed to create clip", err);
    }
  };

  const handleToggleFavorite = async (clip: ClipItem) => {
    // Optimistic Update
    const originalClips = [...clips];
    setClips(clips.map(c => c.id === clip.id ? { ...c, isFavorite: !c.isFavorite } : c));

    try {
      const res = await fetch(`${API_BASE}/clips/${clip.id}`, {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          "x-user-id": USER_ID,
          "x-device-id": DEVICE_ID,
        },
        body: JSON.stringify({
          isFavorite: !clip.isFavorite,
          clientUpdatedAt: Date.now(),
        }),
      });
      const data: ApiResponse<ClipItem> = await res.json();
      if (!data.ok) {
        // Rollback on error
        setClips(originalClips);
      }
    } catch (err) {
      setClips(originalClips);
      console.error("Failed to update clip", err);
    }
  };

  const handleDeleteClip = async (clipId: string) => {
    // Optimistic Update
    const originalClips = [...clips];
    setClips(clips.filter(c => c.id !== clipId));

    try {
      const res = await fetch(`${API_BASE}/clips/${clipId}`, {
        method: "DELETE",
        headers: {
          "x-user-id": USER_ID,
          "x-device-id": DEVICE_ID,
        },
      });
      const data: ApiResponse<ClipItem> = await res.json();
      if (!data.ok) {
        setClips(originalClips);
      } else {
        fetchTags(); // Update tag counts
      }
    } catch (err) {
      setClips(originalClips);
      console.error("Failed to delete clip", err);
    }
  };

  const copyToClipboard = (clip: ClipItem) => {
    navigator.clipboard.writeText(clip.content);
    setCopiedId(clip.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  return (
    <div className="pb-5">
      <Navbar expand="lg" variant="light" className="bg-white border-bottom shadow-sm py-3 mb-4 sticky-top">
        <Container>
          <Navbar.Brand href="#" className="fw-bold d-flex align-items-center">
            <Clipboard className="me-2 text-primary" />
            paste
          </Navbar.Brand>
          <div className="d-flex align-items-center ms-auto">
            <Button 
              variant="light"
              className="rounded-pill me-2 border d-flex align-items-center"
              onClick={() => fetchClips()}
              disabled={loading}
            >
              <RefreshCw size={18} className={loading ? 'spin' : ''} />
            </Button>
            <Button 
              variant="primary" 
              className="rounded-pill d-flex align-items-center px-3 me-2"
              onClick={() => setShowAddModal(true)}
            >
              <Plus size={18} className="me-1" />
              New
            </Button>
            <Button
              variant="outline-secondary"
              className="rounded-pill border shadow-sm p-2"
              onClick={() => setShowSettingsModal(true)}
            >
              <Smartphone size={18} />
            </Button>
          </div>
        </Container>
      </Navbar>

      <Container>
        <div className="search-container mb-4">
          <Row className="g-3">
            <Col md={8}>
              <InputGroup className="bg-white rounded-pill overflow-hidden border shadow-sm">
                <InputGroup.Text className="bg-transparent border-0 ps-3">
                  <Search size={18} className="text-muted" />
                </InputGroup.Text>
                <Form.Control
                  className="border-0 shadow-none py-2"
                  placeholder="Search your clips..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </InputGroup>
            </Col>
            <Col md={4} className="d-flex">
              <Button 
                variant={favoriteOnly ? "primary" : "outline-secondary"} 
                className="rounded-pill me-2 flex-grow-1 border shadow-sm"
                onClick={() => setFavoriteOnly(!favoriteOnly)}
              >
                <Star size={16} className={`me-1 ${favoriteOnly ? 'fill-current' : ''}`} />
                Favorites
              </Button>
              <Dropdown>
                <Dropdown.Toggle variant="outline-secondary" className="rounded-pill border shadow-sm w-100">
                  <Filter size={16} className="me-1" />
                  Filter
                </Dropdown.Toggle>
                <Dropdown.Menu>
                  <Dropdown.Item onClick={() => setSelectedTag(null)} active={selectedTag === null}>
                    All Tags
                  </Dropdown.Item>
                  <Dropdown.Divider />
                  {tags.map(tag => (
                    <Dropdown.Item 
                      key={tag.name} 
                      onClick={() => setSelectedTag(tag.name)}
                      active={selectedTag === tag.name}
                    >
                      #{tag.name} <span className="text-muted small">({tag.clipCount})</span>
                    </Dropdown.Item>
                  ))}
                </Dropdown.Menu>
              </Dropdown>
            </Col>
          </Row>
        </div>

        {loading && clips.length === 0 ? (
          <Row className="g-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <Col key={i} lg={6} xl={4}>
                <Card className="h-100 border-0 shadow-none bg-white opacity-50">
                  <Card.Body className="p-4">
                    <div className="loading-skeleton mb-3" style={{ height: '24px', width: '60px' }}></div>
                    <div className="loading-skeleton mb-3" style={{ height: '20px', width: '80%' }}></div>
                    <div className="loading-skeleton mb-4" style={{ height: '100px', width: '100%' }}></div>
                    <div className="d-flex justify-content-between">
                      <div className="loading-skeleton" style={{ height: '16px', width: '100px' }}></div>
                      <div className="loading-skeleton" style={{ height: '16px', width: '16px' }}></div>
                    </div>
                  </Card.Body>
                </Card>
              </Col>
            ))}
          </Row>
        ) : clips.length === 0 ? (
          <div className="text-center py-5 bg-white rounded-4 shadow-sm border border-dashed" style={{ borderStyle: 'dashed' }}>
            <Clipboard size={64} strokeWidth={1} className="text-light mb-4" />
            <h4 className="fw-bold">No clips found</h4>
            <p className="text-muted mx-auto" style={{ maxWidth: '300px' }}>
              Your clipboard history will appear here once you start saving or syncing content.
            </p>
            <Button variant="primary" className="rounded-pill mt-3 px-4" onClick={() => setShowAddModal(true)}>
              Create First Clip
            </Button>
          </div>
        ) : (
          <>
            <Row className="g-4">
              {clips.map((clip) => (
                <Col key={clip.id} lg={6} xl={4}>
                  <Card className="h-100">
                    <Card.Body className="d-flex flex-column p-4">
                      <div className="d-flex justify-content-between align-items-start mb-3">
                        <Badge bg="light" text="dark" className="clip-type-badge">
                          {clip.type}
                        </Badge>
                        <div className="d-flex gap-1">
                          <Button 
                            variant="link" 
                            className="p-1 text-muted" 
                            onClick={() => handleToggleFavorite(clip)}
                          >
                            <Star size={18} className={clip.isFavorite ? 'text-warning fill-current' : ''} />
                          </Button>
                          <Button 
                            variant="link" 
                            className="p-1 text-muted" 
                            onClick={() => copyToClipboard(clip)}
                          >
                            {copiedId === clip.id ? <Check size={18} className="text-success" /> : <Copy size={18} />}
                          </Button>
                        </div>
                      </div>
                      
                      <div className="flex-grow-1" style={{ cursor: 'pointer' }} onClick={() => copyToClipboard(clip)}>
                        <h6 className="fw-bold mb-2 text-truncate" title={clip.summary}>{clip.summary}</h6>
                        <div className="clip-content p-3 mb-3">
                          <pre className="m-0 text-wrap">{clip.content}</pre>
                        </div>
                      </div>

                      <div className="mt-auto">
                        <div className="mb-2 d-flex flex-wrap">
                          {clip.tags.map((tag: string) => (
                            <span key={tag} className="tag-badge">#{tag}</span>
                          ))}
                        </div>
                        <div className="d-flex justify-content-between align-items-center small text-muted">
                          <span className="d-flex align-items-center opacity-75">
                            <Clock size={12} className="me-1" />
                            {new Date(clip.createdAt).toLocaleDateString()}
                          </span>
                          <Button 
                            variant="link" 
                            className="p-0 text-danger opacity-25 hover-opacity-100 transition-all" 
                            onClick={() => handleDeleteClip(clip.id)}
                          >
                            <Trash2 size={16} />
                          </Button>
                        </div>
                      </div>
                    </Card.Body>
                  </Card>
                </Col>
              ))}
            </Row>
            
            {hasMore && (
              <div className="text-center mt-5">
                <Button 
                  variant="outline-primary" 
                  className="rounded-pill px-5 py-2 fw-600"
                  onClick={() => fetchClips(true)}
                  disabled={loadingMore}
                >
                  {loadingMore ? (
                    <><Spinner size="sm" animation="border" className="me-2" /> Loading...</>
                  ) : (
                    "Load More"
                  )}
                </Button>
              </div>
            )}
          </>
        )}
      </Container>

      <Modal show={showAddModal} onHide={() => setShowAddModal(false)} centered size="lg">
        <Modal.Header closeButton className="border-0">
          <Modal.Title className="fw-bold">Create New Clip</Modal.Title>
        </Modal.Header>
        <Modal.Body className="px-4 pb-4">
          <Form.Group className="mb-3">
            <Form.Control
              as="textarea"
              rows={8}
              placeholder="Paste or type something..."
              className="border-0 bg-light rounded-4 p-3 shadow-none font-monospace"
              value={newClipContent}
              onChange={(e) => setNewClipContent(e.target.value)}
              autoFocus
            />
          </Form.Group>
          <div className="d-flex justify-content-end gap-2">
            <Button variant="light" className="rounded-pill px-4" onClick={() => setShowAddModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" className="rounded-pill px-4" onClick={handleCreateClip}>
              Save Clip
            </Button>
          </div>
        </Modal.Body>
      </Modal>

      <Modal show={showSettingsModal} onHide={() => setShowSettingsModal(false)} centered>
        <Modal.Header closeButton className="border-0">
          <Modal.Title className="fw-bold">Settings</Modal.Title>
        </Modal.Header>
        <Modal.Body className="px-4 pb-4">
          <Form.Group className="mb-3">
            <Form.Label className="small text-muted fw-bold">User ID</Form.Label>
            <Form.Control
              type="text"
              className="bg-light border-0 rounded-3 p-2"
              value={tempUserId}
              onChange={(e) => setTempUserId(e.target.value)}
            />
          </Form.Group>
          <Form.Group className="mb-4">
            <Form.Label className="small text-muted fw-bold">Device ID</Form.Label>
            <Form.Control
              type="text"
              className="bg-light border-0 rounded-3 p-2"
              value={tempDeviceId}
              onChange={(e) => setTempDeviceId(e.target.value)}
            />
          </Form.Group>
          <div className="d-grid">
            <Button variant="primary" className="rounded-pill" onClick={saveSettings}>
              Save and Reload
            </Button>
          </div>
        </Modal.Body>
      </Modal>

      <style>{`
        .spin { animation: spin 1s linear infinite; }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        .fill-current { fill: currentColor; }
      `}</style>
    </div>
  );
};

export default App;
