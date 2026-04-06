/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserRouter, Routes, Route, useParams, useNavigate, Link, useLocation } from 'react-router-dom';
import { useState, useEffect, useRef } from 'react';
import { Folder, File, Download, Upload, Lock, ChevronRight, Home, FileText, Copy, Check } from 'lucide-react';

function ViewHandler() {
  const { '*': pathParam } = useParams();
  const path = pathParam || '';
  const [password, setPassword] = useState('');
  const location = useLocation();
  const hasError = new URLSearchParams(location.search).get('error') === '1';

  const handleDownload = () => {
    window.location.href = `/d/${path}?password=${encodeURIComponent(password)}`;
  };

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col items-center justify-center p-4">
      <div className="bg-white p-8 rounded-xl shadow-lg max-w-md w-full">
        <div className="flex justify-center mb-6">
          <div className="bg-blue-100 p-3 rounded-full">
            <Lock className="w-8 h-8 text-blue-600" />
          </div>
        </div>
        <h2 className="text-2xl font-bold text-center mb-2">Protected File</h2>
        <p className="text-gray-500 text-center mb-6 break-all">{path}</p>
        
        {hasError && (
          <div className="bg-red-50 text-red-600 p-3 rounded-lg mb-4 text-sm text-center">
            Incorrect password. Please try again.
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500 outline-none"
              placeholder="Enter password to download"
              onKeyDown={(e) => e.key === 'Enter' && handleDownload()}
            />
          </div>
          <button
            onClick={handleDownload}
            className="w-full bg-blue-600 text-white font-medium py-2 px-4 rounded-lg hover:bg-blue-700 transition-colors"
          >
            Download File
          </button>
          <div className="text-center mt-4">
            <Link to="/" className="text-sm text-blue-600 hover:underline">
              Back to Home
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

function Explorer() {
  const { '*': pathParam } = useParams();
  const path = pathParam || '';
  const [items, setItems] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadPassword, setUploadPassword] = useState('');
  const [showUploadModal, setShowUploadModal] = useState(false);
  const [uploadPath, setUploadPath] = useState(path);
  const [copiedPath, setCopiedPath] = useState<string | null>(null);

  useEffect(() => {
    fetchItems();
    setUploadPath(path);
  }, [path]);

  const fetchItems = async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/list/${path}`);
      const data = await res.json();
      if (data.items) {
        const sorted = data.items.sort((a: any, b: any) => {
          if (a.isDirectory && !b.isDirectory) return -1;
          if (!a.isDirectory && b.isDirectory) return 1;
          return a.name.localeCompare(b.name);
        });
        setItems(sorted);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  };

  const handleUpload = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!fileInputRef.current?.files?.length) return;
    const file = fileInputRef.current.files[0];
    
    const formData = new FormData();
    formData.append('file', file);
    
    let cleanPath = uploadPath.replace(/^\/+/, '');
    const fullPath = cleanPath ? `${cleanPath}/${file.name}` : file.name;
    
    formData.append('path', fullPath);
    if (uploadPassword) {
      formData.append('password', uploadPassword);
    }

    setUploading(true);
    try {
      const res = await fetch('/api/upload', {
        method: 'POST',
        body: formData,
      });
      if (res.ok) {
        setShowUploadModal(false);
        setUploadPassword('');
        if (fileInputRef.current) fileInputRef.current.value = '';
        fetchItems();
      } else {
        alert('Upload failed');
      }
    } catch (e) {
      console.error(e);
      alert('Upload failed');
    } finally {
      setUploading(false);
    }
  };

  const formatSize = (bytes: number) => {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const breadcrumbs = path.split('/').filter(Boolean);

  return (
    <div className="min-h-screen bg-gray-50 flex flex-col">
      <header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between sticky top-0 z-10">
        <div className="flex items-center space-x-2 text-gray-800">
          <Link to="/" className="hover:bg-gray-100 p-1.5 rounded-md transition-colors">
            <Home className="w-5 h-5" />
          </Link>
          {breadcrumbs.map((crumb, idx) => {
            const crumbPath = breadcrumbs.slice(0, idx + 1).join('/');
            return (
              <div key={crumbPath} className="flex items-center space-x-2">
                <ChevronRight className="w-4 h-4 text-gray-400" />
                <Link to={`/${crumbPath}`} className="hover:text-blue-600 font-medium transition-colors">
                  {crumb}
                </Link>
              </div>
            );
          })}
        </div>
        <div className="flex items-center space-x-4">
          <a href="/skill.md" target="_blank" className="text-sm text-gray-500 hover:text-gray-900 flex items-center space-x-1">
            <FileText className="w-4 h-4" />
            <span>AI Skill</span>
          </a>
          <button
            onClick={() => setShowUploadModal(true)}
            className="flex items-center space-x-2 bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
          >
            <Upload className="w-4 h-4" />
            <span>Upload</span>
          </button>
        </div>
      </header>

      <main className="flex-1 p-6 max-w-6xl mx-auto w-full">
        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
          <div className="grid grid-cols-12 gap-4 p-4 border-b border-gray-100 bg-gray-50/50 text-xs font-semibold text-gray-500 uppercase tracking-wider">
            <div className="col-span-6 md:col-span-7">Name</div>
            <div className="col-span-3 md:col-span-2 text-right">Size</div>
            <div className="col-span-3 md:col-span-3 text-right">Last Modified</div>
          </div>
          
          {loading ? (
            <div className="p-8 text-center text-gray-500">Loading...</div>
          ) : items.length === 0 ? (
            <div className="p-12 text-center flex flex-col items-center justify-center">
              <div className="bg-gray-50 p-4 rounded-full mb-4">
                <Folder className="w-12 h-12 text-gray-300" />
              </div>
              <h3 className="text-lg font-medium text-gray-900 mb-1">Empty Folder</h3>
              <p className="text-gray-500">No files or folders here yet.</p>
            </div>
          ) : (
            <div className="divide-y divide-gray-100">
              {items.map((item) => (
                <div key={item.path} className="grid grid-cols-12 gap-4 p-4 items-center hover:bg-gray-50 transition-colors group">
                  <div className="col-span-6 md:col-span-7 flex items-center space-x-3 overflow-hidden">
                    {item.isDirectory ? (
                      <Folder className="w-5 h-5 text-blue-400 flex-shrink-0" />
                    ) : (
                      <File className="w-5 h-5 text-gray-400 flex-shrink-0" />
                    )}
                    
                    {item.isDirectory ? (
                      <Link to={`/${item.path}`} className="font-medium text-gray-900 hover:text-blue-600 truncate">
                        {item.name}
                      </Link>
                    ) : (
                      <div className="flex items-center space-x-2 overflow-hidden w-full">
                        <span className="font-medium text-gray-900 truncate">{item.name}</span>
                        {item.isProtected && <Lock className="w-3 h-3 text-amber-500 flex-shrink-0" />}
                      </div>
                    )}
                  </div>
                  
                  <div className="col-span-3 md:col-span-2 text-right text-sm text-gray-500">
                    {!item.isDirectory && formatSize(item.size)}
                  </div>
                  
                  <div className="col-span-3 md:col-span-3 flex items-center justify-end space-x-4 text-sm text-gray-500">
                    <span className="hidden md:inline">{new Date(item.updatedAt).toLocaleDateString()}</span>
                    {(
                      <div className="flex items-center space-x-1">
                        <button
                          onClick={() => {
                            const url = `${window.location.origin}/d/${item.path}`;
                            navigator.clipboard.writeText(url);
                            setCopiedPath(item.path);
                            setTimeout(() => setCopiedPath(null), 2000);
                          }}
                          className="p-1.5 text-gray-400 hover:text-green-600 hover:bg-green-50 rounded-md opacity-0 group-hover:opacity-100 transition-all"
                          title={item.isDirectory ? "Copy folder zip link" : "Copy download link"}
                        >
                          {copiedPath === item.path ? <Check className="w-4 h-4 text-green-500" /> : <Copy className="w-4 h-4" />}
                        </button>
                        <button
                          onClick={() => {
                            if (!item.isDirectory && item.isProtected) {
                              window.location.href = `/view/${item.path}`;
                            } else {
                              window.location.href = `/d/${item.path}`;
                            }
                          }}
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-md opacity-0 group-hover:opacity-100 transition-all"
                          title={item.isDirectory ? "Download as zip" : "Download"}
                        >
                          <Download className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>

      {showUploadModal && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6">
            <h2 className="text-xl font-bold mb-4">Upload File</h2>
            <form onSubmit={handleUpload} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Select File</label>
                <input
                  type="file"
                  ref={fileInputRef}
                  required
                  className="w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-md file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100"
                />
              </div>
              
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Upload Path (Folder)</label>
                <input
                  type="text"
                  value={uploadPath}
                  onChange={(e) => setUploadPath(e.target.value)}
                  placeholder="e.g. documents/reports"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-1">Password Protection (Optional)</label>
                <input
                  type="password"
                  value={uploadPassword}
                  onChange={(e) => setUploadPassword(e.target.value)}
                  placeholder="Leave empty for no password"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md focus:ring-blue-500 focus:border-blue-500 outline-none"
                />
              </div>

              <div className="flex space-x-3 pt-4">
                <button
                  type="button"
                  onClick={() => setShowUploadModal(false)}
                  className="flex-1 px-4 py-2 border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={uploading}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 transition-colors disabled:opacity-50 flex items-center justify-center"
                >
                  {uploading ? 'Uploading...' : 'Upload'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/view/*" element={<ViewHandler />} />
        <Route path="/*" element={<Explorer />} />
      </Routes>
    </BrowserRouter>
  );
}
